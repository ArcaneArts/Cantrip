// Actual HTTP routes, worker commands and ordered committed Live publications.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { workerLinkResourceGrantSchema } from "../../packages/protocol/dist/worker-link.js";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const resources = ["browser", "remote-desktop", "project-view"];
const events = (live) =>
  live.history
    .filter(
      (e) =>
        e.type === "event" &&
        [...resources, "project-tab-layout"].includes(e.resource),
    )
    .map(({ resource, scope, entityId, revision, payload, action }) => ({
      resource,
      scope,
      entityId,
      revision,
      payload,
      action,
    }));
async function until(read, label) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}
export async function remoteSurfaceWorkerLinkCases({
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
  const initial = events(live).length;
  const session = await visit(
    "surface WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "surface-http-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`,
    route = (id) => `${base}/remote-surfaces/${id}/grant`;
  const body = { viewport: { width: 1024, height: 768, devicePixelRatio: 1 } };
  async function transition(label, id, status, updates = 2) {
    await live.ping();
    const start = events(live).length;
    const value = await visit(label, "POST", route(id), { json: body, status });
    await live.ping();
    const delta = events(live).slice(start);
    (result.surfaceGrantChecks ??= []).push({ label, delta });
    const expectedResources = [
      ...Array.from({ length: updates }, () => resources).flat(),
      ...(status < 400 ? [...resources, "project-tab-layout"] : []),
    ];
    assert.equal(
      delta.length,
      expectedResources.length,
      label + " status and response publications",
    );
    assert.deepEqual(
      delta,
      expectedResources.map((resource) => ({
        resource,
        scope: { kind: "current-user" },
        entityId: id,
        revision: null,
        payload: null,
        action: "invalidated",
      })),
      label + " exact ordered publications",
    );
    return value;
  }
  for (const json of [
    undefined,
    null,
    {},
    [],
    { viewport: {} },
    { ...body, extra: true },
    { viewport: { ...body.viewport, width: 0 } },
    { viewport: { ...body.viewport, devicePixelRatio: 9 } },
  ])
    await visit(
      "invalid surface grant " + JSON.stringify(json),
      "POST",
      "/api/worker-links/55555555-5555-4555-8555-555555555555/remote-surfaces/missing/grant",
      { json, status: 400 },
    );
  await visit(
    "unknown surface grant session",
    "POST",
    "/api/worker-links/55555555-5555-4555-8555-555555555555/remote-surfaces/missing/grant",
    { json: body, status: 404 },
  );
  for (const [id, status] of [
    ["missing", 404],
    ["other-remote", 404],
    ["foreign-project-owned-worker", 404],
    ["placement-surface", 409],
  ])
    await visit("surface grant resource " + id, "POST", route(id), {
      json: body,
      status,
    });
  if (profile === "accounts")
    await visit(
      "foreign surface grant session hidden",
      "POST",
      route("browser"),
      { client: "other", json: body, status: 404 },
    );
  for (const [id, kind, stateResource] of [
    ["browser", "browser", "browser-row"],
    ["raw-browser", "browser", "browser-remote-surface"],
    ["desktop", "remote-desktop", "remote-desktop-row"],
    ["remote", "remote-desktop", "remote-desktop-row"],
  ]) {
    const at = result.commands.length,
      value = await transition("open surface " + id, id, 201);
    workerLinkResourceGrantSchema.parse(value);
    assert.equal(value.binding.resource.kind, kind);
    assert.equal(value.binding.resource.resourceId, id);
    assert.deepEqual(value.binding.lanes, ["interactive", "realtime"]);
    assert.equal(value.binding.maxChannels, 2);
    assert.deepEqual(value.binding.operations, [
      "stream:open",
      "stream:read",
      "stream:write",
    ]);
    const commands = result.commands.slice(at),
      attach = commands.find((c) => c.type === "surface.attach"),
      install = commands.find((c) => c.type === "worker-link.grant.install");
    assert.ok(attach && install);
    assert.equal(attach.attachmentId, value.binding.resource.attachmentId);
    assert.equal(attach.stateResource, stateResource);
    assert.equal(attach.preferredTransport, "websocket");
    assert.equal(attach.webrtc, null);
    assert.deepEqual(attach.viewport, body.viewport);
    if (kind === "browser") assert.equal(attach.desktopStream, null);
    else {
      assert.ok(attach.desktopStream.targetFps > 0);
      assert.ok(
        ["adaptive", "data-saver", "balanced", "sharp"].includes(
          attach.desktopStream.quality,
        ),
      );
    }
    assert.equal(
      install.grant.tokenHash,
      createHash("sha256").update(value.token).digest("hex"),
    );
    assert.equal(install.grant.token, undefined);
    await visit(
      "release surface " + id,
      "DELETE",
      `${base}/grants/${value.binding.grantId}`,
      { status: 204 },
    );
  }
  for (const mode of [
    "surface-error",
    "surface-invalid",
    "surface-grant-reject",
  ]) {
    state.mode = mode;
    const at = result.commands.length;
    await transition(
      "surface grant " + mode,
      "raw-browser",
      mode === "surface-grant-reject" ? 409 : 502,
    );
    assert.equal(
      result.commands.slice(at).filter((c) => c.type === "surface.detach")
        .length,
      mode === "surface-grant-reject" ? 1 : 0,
    );
    state.mode = "normal";
  }
  if (databaseMode === "postgres") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    try {
      for (const deleted of [false, true]) {
        const id = deleted ? "disposable-surface" : "raw-browser",
          at = result.commands.length;
        state.onInstall = async () => {
          if (deleted) await sql`DELETE FROM remote_surfaces WHERE id=${id}`;
          else
            await sql`UPDATE remote_surfaces SET state_revision=state_revision+1 WHERE id=${id}`;
        };
        try {
          await transition(
            "surface post-install " + (deleted ? "deleted" : "changed"),
            id,
            deleted ? 404 : 409,
            1,
          );
        } finally {
          state.onInstall = undefined;
        }
        const commands = result.commands.slice(at),
          revoke = commands.filter(
            (c) => c.type === "worker-link.grant.revoke",
          );
        assert.equal(revoke.length, 1);
        assert.equal(
          revoke[0].revocation.reason,
          deleted ? "resource-deleted" : "resource-stopped",
        );
        assert.equal(
          commands.some((c) => c.type === "surface.detach"),
          false,
        );
      }
      await sql`UPDATE remote_surfaces SET protected_label='42'::jsonb WHERE id='raw-browser'`;
      const at = result.commands.length;
      await transition(
        "surface primitive protected label preserves property failure",
        "raw-browser",
        502,
      );
      assert.equal(
        result.commands.slice(at).some((c) => c.type === "surface.attach"),
        false,
      );
      await sql`UPDATE remote_surfaces SET protected_label=(SELECT protected_label FROM remote_surfaces WHERE id='placement-surface') WHERE id='raw-browser'`;
      // The catch's own write can fail too. The actual SQL failure must still
      // execute the finally detach for an attachment whose grant was rejected.
      await sql`UPDATE remote_surfaces SET status='idle',last_error=NULL WHERE id='raw-browser'`;
      await sql`ALTER TABLE remote_surfaces ADD CONSTRAINT fixture_surface_error_write CHECK(id <> 'raw-browser' OR status <> 'error')`;
      state.mode = "surface-grant-reject";
      const cleanupStart = result.commands.length;
      try {
        await transition(
          "surface catch status failure still detaches",
          "raw-browser",
          500,
          1,
        );
        assert.equal(
          result.commands
            .slice(cleanupStart)
            .filter((c) => c.type === "surface.detach").length,
          1,
        );
      } finally {
        state.mode = "normal";
        await sql`ALTER TABLE remote_surfaces DROP CONSTRAINT fixture_surface_error_write`;
      }
    } finally {
      state.onInstall = undefined;
      await sql.end();
    }
  }
  await live.ping();
  const start = events(live).length;
  state.mode = "surface-hold";
  const controller = new AbortController(),
    client = fixture.client();
  const pending = new Promise((resolve) => {
    const request = httpRequest(
      fixture.server.origin + route("raw-browser"),
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
    request.end(JSON.stringify(body));
  });
  const held = await until(
    () => state.surfaceHeld,
    "surface attach reached before caller abort",
  );
  controller.abort();
  assert.deepEqual(await pending, { error: "AbortError" });
  held.resolve({ accepted: true, transport: "websocket" });
  state.surfaceHeld = undefined;
  state.mode = "normal";
  await until(
    () => events(live).length >= start + 6,
    "abandoned surface grant completes active state",
  );
  await live.ping();
  assert.deepEqual(
    events(live).slice(start),
    Array.from({ length: 2 }, () =>
      resources.map((resource) => ({
        resource,
        scope: { kind: "current-user" },
        entityId: "raw-browser",
        revision: null,
        payload: null,
        action: "invalidated",
      })),
    ).flat(),
  );
  const desktopGrants = [];
  for (let index = 0; index < 2; index++)
    desktopGrants.push(
      await transition(
        `desktop grant before view deletion ${index}`,
        "desktop",
        201,
      ),
    );
  if (profile === "accounts") {
    const at = result.commands.length;
    await visit(
      "foreign view deletion preserves grants",
      "DELETE",
      "/api/project-views/desktop",
      {
        client: "other",
        status: 404,
      },
    );
    assert.deepEqual(result.commands.slice(at), []);
    await visit(
      "desktop grant survives foreign deletion",
      "POST",
      `${base}/grants/${desktopGrants[0].binding.grantId}/renew`,
    );
  }
  const deletionStart = result.commands.length;
  await visit(
    "delete view with active desktop grants",
    "DELETE",
    "/api/project-views/desktop",
    {
      status: 204,
    },
  );
  await until(
    () =>
      result.commands
        .slice(deletionStart)
        .some((command) => command.type === "surface.close"),
    "view deletion reaches surface close",
  );
  const deletionCommands = result.commands.slice(deletionStart);
  assert.deepEqual(
    deletionCommands.map((command) => command.type),
    ["worker-link.grant.revoke", "worker-link.grant.revoke", "surface.close"],
  );
  assert.deepEqual(
    deletionCommands.slice(0, 2).map((command) => ({
      grantId: command.grantId,
      reason: command.revocation.reason,
    })),
    desktopGrants.map((grant) => ({
      grantId: grant.binding.grantId,
      reason: "resource-deleted",
    })),
  );
  assert.equal(deletionCommands[2].surfaceId, "desktop");
  for (const [index, grant] of desktopGrants.entries())
    await visit(
      `deleted view grant cannot renew ${index}`,
      "POST",
      `${base}/grants/${grant.binding.grantId}/renew`,
      { status: 409 },
    );
  await visit(
    "deleted view cannot issue desktop grant",
    "POST",
    route("desktop"),
    {
      json: body,
      status: 404,
    },
  );
  await visit(
    "repeat active-grant view deletion",
    "DELETE",
    "/api/project-views/desktop",
    {
      status: 404,
    },
  );
  assert.equal(result.commands.length, deletionStart + 3);
  await visit("release surface WorkerLink session", "DELETE", base, {
    status: 204,
  });
  result.surfaceGrantCommands = fixture.normalize(result.commands.slice(begin));
  result.surfaceGrantTransitions = events(live).slice(initial);
}
