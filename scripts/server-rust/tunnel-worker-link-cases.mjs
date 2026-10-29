import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { workerLinkTunnelGrantSchema } from "../../packages/protocol/dist/worker-link.js";
import {
  tunnelIds,
  attachmentIds,
  tunnelRecord,
  secretExpiry,
  tunnelExpiry,
} from "./tunnel-state.mjs";
import { literal } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
export const tunnelEvents = (live) =>
  live.history
    .filter((e) => e.type === "event" && e.resource === "tunnel")
    .map(({ resource, scope, entityId, revision, payload, action }) => ({
      resource,
      scope,
      entityId,
      revision,
      payload,
      action,
    }));
async function until(read, label, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}
export async function tunnelWorkerLinkCases({
  fixture,
  visit,
  state,
  result,
  profile,
  databaseMode,
  live,
}) {
  const begin = result.commands.length;
  await live.ping();
  const initial = tunnelEvents(live).length;
  const session = await visit(
    "tunnel WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "tunnel-http-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`,
    route = (id) => `${base}/tunnel-attachments/${id}/grant`;
  const publication = {
    resource: "tunnel",
    scope: { kind: "project", projectId: "github" },
    entityId: tunnelIds.main,
    revision: null,
    payload: null,
    action: "invalidated",
  };
  async function transition(
    label,
    id,
    status,
    json = {},
    count = status === 201 ? 1 : 0,
  ) {
    await live.ping();
    const at = tunnelEvents(live).length;
    const value = await visit(label, "POST", route(id), { json, status });
    await live.ping();
    const events = tunnelEvents(live).slice(at);
    (result.tunnelGrantChecks ??= []).push({ label, events });
    assert.deepEqual(
      events,
      Array.from({ length: count }, () => publication),
      label + " exact committed runtime invalidation",
    );
    return value;
  }
  for (const json of [
    null,
    [],
    42,
    { diagnosticTraceId: "bad" },
    { extra: true },
  ])
    await visit(
      "invalid tunnel grant " + JSON.stringify(json),
      "POST",
      "/api/worker-links/55555555-5555-4555-8555-555555555555/tunnel-attachments/missing/grant",
      { json, status: 400 },
    );
  await visit(
    "undefined tunnel body defaults before authority",
    "POST",
    "/api/worker-links/55555555-5555-4555-8555-555555555555/tunnel-attachments/missing/grant",
    { status: 404 },
  );
  for (const [id, status] of [
    ["missing", 404],
    [attachmentIds.foreign, 404],
    ["placement-tunnel-attachment", 409],
  ])
    await transition("tunnel grant resource " + id, id, status);
  if (profile === "accounts")
    await visit(
      "foreign tunnel session hidden",
      "POST",
      route(attachmentIds.main),
      { client: "other", json: {}, status: 404 },
    );
  async function opened(label, json) {
    const at = result.commands.length;
    const value = await transition(label, attachmentIds.main, 201, json);
    workerLinkTunnelGrantSchema.parse(value);
    const { grant, route: target } = value;
    assert.equal(grant.binding.resource.kind, "tunnel");
    assert.equal(grant.binding.resource.resourceId, tunnelIds.main);
    assert.equal(grant.binding.resource.attachmentId, attachmentIds.main);
    assert.deepEqual(grant.binding.lanes, ["stream"]);
    assert.equal(grant.binding.maxChannels, 1);
    assert.deepEqual(grant.binding.operations, [
      "stream:open",
      "stream:read",
      "stream:write",
      "stream:half-close",
    ]);
    assert.equal(
      target.sourceEndpointId,
      "worker-link-client:" + grant.binding.grantId,
    );
    assert.equal(target.destinationEndpointId, "worker-link-worker:alpha");
    assert.equal(target.target.kind, "protected-tunnel");
    assert.equal(target.target.recordId, tunnelIds.main);
    assert.deepEqual(target.target.protectedRecord, tunnelRecord);
    const install = result.commands
      .slice(at)
      .find((c) => c.type === "worker-link.grant.install");
    assert.ok(install);
    assert.equal(
      install.grant.tokenHash,
      createHash("sha256").update(grant.token).digest("hex"),
    );
    assert.equal(install.grant.token, undefined);
    await visit(
      "release " + label,
      "DELETE",
      `${base}/grants/${grant.binding.grantId}`,
      { status: 204 },
    );
    return value;
  }
  await opened("tunnel stream grant", {});
  await opened("diagnostic trace is accepted without changing the route", {
    diagnosticTraceId: "55555555-5555-4555-8555-555555555555",
  });
  state.mode = "grant-reject";
  await transition(
    "tunnel rejected grant installation",
    attachmentIds.main,
    409,
  );
  state.mode = "normal";
  if (databaseMode === "postgres") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    try {
      for (const scenario of ["client-replaced", "secret-rotated", "deleted"]) {
        const at = result.commands.length;
        state.onInstall = async () => {
          if (scenario === "deleted")
            await sql`DELETE FROM tunnel_attachments WHERE id=${attachmentIds.main}`;
          else if (scenario === "client-replaced")
            await sql`UPDATE tunnel_attachments SET client_id='changed-client' WHERE id=${attachmentIds.main}`;
          else
            await sql`UPDATE tunnel_attachments SET secret_expires_at=secret_expires_at+interval '1 millisecond' WHERE id=${attachmentIds.main}`;
        };
        try {
          await transition(
            "tunnel post-install " + scenario,
            attachmentIds.main,
            scenario === "deleted" ? 404 : 409,
          );
        } finally {
          state.onInstall = undefined;
        }
        const commands = result.commands.slice(at),
          revoked = commands.filter(
            (c) => c.type === "worker-link.grant.revoke",
          );
        assert.equal(revoked.length, 1);
        assert.equal(
          revoked[0].revocation.reason,
          scenario === "deleted" ? "resource-deleted" : "resource-stopped",
        );
        if (scenario === "client-replaced")
          await sql`UPDATE tunnel_attachments SET client_id='client-main' WHERE id=${attachmentIds.main}`;
      }
      await sql`INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,secret_hash,status,secret_expires_at,expires_at) VALUES(${attachmentIds.main},${tunnelIds.main},'desktop-loopback','client-main','restored-http-secret','offline',${secretExpiry},${tunnelExpiry})`;
      await sql.unsafe(
        `ALTER TABLE tunnels ADD CONSTRAINT fixture_tunnel_activation_failure CHECK(id<>${literal(tunnelIds.main)} OR status<>'active') NOT VALID`,
      );
      const at = result.commands.length;
      try {
        await transition(
          "tunnel SQL activation failure compensates grant",
          attachmentIds.main,
          502,
        );
        assert.equal(
          result.commands
            .slice(at)
            .filter((c) => c.type === "worker-link.grant.revoke").length,
          1,
        );
      } finally {
        await sql`ALTER TABLE tunnels DROP CONSTRAINT fixture_tunnel_activation_failure`;
      }
    } finally {
      state.onInstall = undefined;
      state.mode = "normal";
      await sql.end();
    }
  }
  // An admitted installation remains owned after its HTTP caller disconnects.
  await live.ping();
  const before = tunnelEvents(live).length;
  let release;
  state.onInstall = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const controller = new AbortController(),
    client = fixture.client();
  const pending = new Promise((resolve) => {
    const request = httpRequest(
      fixture.server.origin + route(attachmentIds.main),
      {
        method: "POST",
        signal: controller.signal,
        agent: false,
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          connection: "close",
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      },
    );
    request.on("error", (error) => resolve({ error: error.name }));
    request.end("{}");
  });
  await until(() => release, "tunnel installation reached before abort");
  controller.abort();
  assert.deepEqual(await pending, { error: "AbortError" });
  release();
  state.onInstall = undefined;
  await until(
    () => tunnelEvents(live).length > before,
    "abandoned tunnel grant is activated",
  );
  await live.ping();
  assert.deepEqual(tunnelEvents(live).slice(before), [publication]);
  await visit("release tunnel WorkerLink session", "DELETE", base, {
    status: 204,
  });
  if (databaseMode === "postgres" && profile === "none") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    try {
      await live.ping();
      const at = tunnelEvents(live).length;
      await sql`UPDATE tunnel_attachments SET status='active',last_seen_at=NULL,error_code=NULL WHERE id=${attachmentIds.main}`;
      await sql`INSERT INTO tunnel_attachment_direct_leases(capability_id,attachment_id,lease_expires_at,status) VALUES('actual-minute-expiry',${attachmentIds.main},now()-interval '1 second','active')`;
      // The real producer uses JavaScript Date (millisecond precision). Raw
      // PostgreSQL now() has microseconds and would intentionally fail the
      // source's exact Date-based stop fence; that boundary is tested separately.
      await sql`UPDATE tunnel_attachments SET status='offline',last_seen_at=NULL,expires_at=date_trunc('milliseconds',now())-interval '1 second' WHERE id=${attachmentIds.sibling}`;
      const expiryStarted = Date.now();
      try {
        const deadline = Date.now() + 80000;
        while (tunnelEvents(live).length < at + 2) {
          await live.ping();
          assert.ok(
            Date.now() < deadline,
            "actual minute timer expires lease and attachment",
          );
          await delay(1000);
        }
      } catch (error) {
        result.tunnelExpiry = {
          error: error.message,
          events: tunnelEvents(live).slice(at),
          attachments:
            await sql`SELECT id,status,error_code,last_seen_at,expires_at FROM tunnel_attachments ORDER BY id`,
          leases: await sql`SELECT * FROM tunnel_attachment_direct_leases`,
          serverDiagnostics: fixture.server.diagnostics(),
        };
        throw error;
      }
      await live.ping();
      assert.deepEqual(tunnelEvents(live).slice(at), [
        publication,
        publication,
      ]);
      const rows =
        await sql`SELECT id,status,error_code FROM tunnel_attachments WHERE id IN (${attachmentIds.main},${attachmentIds.sibling}) ORDER BY id`;
      assert.deepEqual(
        rows.map((r) => ({ ...r })),
        [
          {
            id: attachmentIds.main,
            status: "offline",
            error_code: "attachment-disconnected",
          },
          {
            id: attachmentIds.sibling,
            status: "failed",
            error_code: "attachment-expired",
          },
        ],
      );
      assert.equal(
        (
          await sql`SELECT capability_id FROM tunnel_attachment_direct_leases WHERE capability_id='actual-minute-expiry'`
        ).length,
        0,
      );
      result.tunnelExpiry = {
        actualTimer: true,
        elapsedMs: Date.now() - expiryStarted,
        events: tunnelEvents(live).slice(at),
        rows: rows.map((r) => ({ ...r })),
      };
    } finally {
      await sql.end();
    }
  }
  result.tunnelGrantCommands = fixture.normalize(result.commands.slice(begin));
  result.tunnelGrantTransitions = tunnelEvents(live).slice(initial);
}
