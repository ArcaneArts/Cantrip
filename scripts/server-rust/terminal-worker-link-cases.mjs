import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFixture } from "./http-fixture.mjs";
import { workerLinkResourceGrantSchema } from "../../packages/protocol/dist/worker-link.js";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
export class TerminalLinkFixture extends HttpFixture {
  normalize(value, key = "") {
    if (key === "leaseExpiresAt" && typeof value === "string") {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(
        Date.parse(value) > Date.now() + 11 * 3600000 &&
          Date.parse(value) <= Date.now() + 12 * 3600000 + 1000,
      );
      return "<terminal-direct-lease-expiry>";
    }
    if (key === "secret" && typeof value === "string") {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, "base64url").length, 32);
      this.directSecrets ??= new Map();
      if (!this.directSecrets.has(value))
        this.directSecrets.set(
          value,
          `<direct-secret:${this.directSecrets.size}>`,
        );
      return this.directSecrets.get(value);
    }
    if (
      typeof value === "string" &&
      (value.startsWith("direct-bootstrap:") || value.startsWith("desktop:"))
    ) {
      const id = value.slice(-36);
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      return value.slice(0, -36) + super.normalize(id);
    }
    if (
      key === "error" &&
      typeof value === "string" &&
      (value.startsWith('Failed query: update "tunnels" set ') ||
        value.startsWith(
          'Failed query: update "terminals" set "active_worker_id"',
        ) ||
        value.startsWith(
          'Failed query: update "run_configuration_runtimes" set "terminal_id"',
        ))
    ) {
      const dates =
        value.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g) ?? [];
      assert.equal(
        dates.length,
        1,
        "one real write timestamp in the exact SQL error",
      );
      assert.ok(
        Date.parse(dates[0]) >= Date.now() - 30000 &&
          Date.parse(dates[0]) <= Date.now() + 1000,
      );
      let normalized = value.replace(dates[0], "<http-write-time>");
      if (
        value.startsWith(
          'Failed query: update "run_configuration_runtimes" set "terminal_id"',
        )
      ) {
        const params = normalized.match(
          /\nparams: ,<http-write-time>,([^,]+),delete-error-terminal$/,
        );
        assert.ok(params, "exact runtime-clear query parameter sequence");
        assert.equal(
          params[1],
          this.sqlErrorOwner,
          "SQL error retains the actual authenticated owner",
        );
        normalized = normalized.replace(
          `,${params[1]},delete-error-terminal`,
          `,${super.normalize(params[1])},delete-error-terminal`,
        );
      }
      return normalized;
    }
    if (typeof value === "string" && value.startsWith("worker-link-client:"))
      return (
        "worker-link-client:" +
        super.normalize(value.slice("worker-link-client:".length))
      );
    if (key === "token" && typeof value === "string") {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, "base64url").length, 32);
      this.grantTokens ??= new Map();
      if (!this.grantTokens.has(value))
        this.grantTokens.set(value, `<grant-token:${this.grantTokens.size}>`);
      this.grantHashes ??= new Map();
      this.grantHashes.set(
        createHash("sha256").update(value).digest("hex"),
        this.grantTokens.get(value) + ":sha256",
      );
      return this.grantTokens.get(value);
    }
    if (key === "tokenHash" && this.grantHashes?.has(value))
      return this.grantHashes.get(value);
    if (key === "tokenHash") {
      assert.match(value, /^[a-f0-9]{64}$/);
      this.unreturnedHashes ??= new Map();
      if (!this.unreturnedHashes.has(value))
        this.unreturnedHashes.set(
          value,
          `<unreturned-hash:${this.unreturnedHashes.size}>`,
        );
      return this.unreturnedHashes.get(value);
    }
    if (key === "absoluteExpiresAt" && typeof value === "string") {
      assert.ok(
        Date.parse(value) > Date.now() &&
          Date.parse(value) <= Date.now() + 43200000 + 1000,
      );
      return "<absolute-lease-expiry>";
    }
    if (
      typeof value === "string" &&
      value.startsWith("worker-link-bootstrap:")
    ) {
      const id = value.slice("worker-link-bootstrap:".length);
      assert.match(id, /^[a-f0-9-]{36}$/);
      return "worker-link-bootstrap:" + super.normalize(id);
    }
    return super.normalize(value, key);
  }
}
export function terminalGrantWorker({ serverId, owner, commands }) {
  const state = {
    mode: "normal",
    pending: new Map(),
    commands,
    detachFailures: 0,
  };
  state.handle = async (command, emit) => {
    if (command.type === "terminal.input") {
      if (state.relayMode === "hold-input")
        return await new Promise((resolve, reject) => {
          state.relayInputHeld = { resolve, reject, command };
        });
      return null;
    }
    if (command.type === "terminal.resize") {
      if (state.relayMode === "resize-error")
        throw new Error("Controlled terminal resize failure");
      return null;
    }
    if (command.type.startsWith("direct.capability.")) {
      if (command.type === "direct.capability.prepare") {
        if (state.directMode === "error")
          throw new Error("Controlled direct preparation failure");
        if (state.directMode === "hold")
          return await new Promise((resolve) => {
            state.directHeld = { resolve, command };
          });
        return {
          accepted: true,
          capabilityId:
            state.directMode === "mismatch"
              ? "55555555-5555-4555-8555-555555555555"
              : command.binding.capabilityId,
        };
      }
      if (command.type === "direct.capability.renew")
        return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
      return null;
    }
    if (command.type.startsWith("worker-link.")) {
      if (command.type === "worker-link.identity.resolve")
        return {
          serverId,
          ownerId: owner,
          workerId: "alpha",
          workerProcessGeneration: "99999999-9999-4999-8999-999999999999",
        };
      if (command.type === "worker-link.grant.install")
        await state.onInstall?.(command);
      if (command.type === "worker-link.grant.revoke")
        await state.onRevoke?.(command);
      return {
        accepted: !(
          ["grant-reject", "surface-grant-reject"].includes(state.mode) &&
          command.type === "worker-link.grant.install"
        ),
      };
    }
    if (command.type === "chat.thread.ensure")
      return { threadId: "http-console-thread" };
    if (command.type === "surface.attach") {
      if (state.mode === "surface-error")
        throw new Error("Controlled surface attachment failure");
      if (state.mode === "surface-invalid")
        return { accepted: false, transport: "websocket" };
      if (state.mode === "surface-hold")
        return await new Promise((resolve) => {
          state.surfaceHeld = { resolve, command };
        });
      return { accepted: true, transport: "websocket" };
    }
    if (command.type === "surface.detach") return null;
    if (command.type === "terminal.close") {
      if (state.mode === "close-error")
        throw new Error("Controlled terminal close failure");
      return null;
    }
    if (command.type === "terminal.open") {
      if (state.mode === "open-error")
        throw new Error("Controlled terminal opening failure");
      if (state.mode === "exited")
        return { status: "exited", exitCode: 2, signal: null };
      if (state.mode === "invalid-open") return { status: "running" };
      if (["ready-invalid", "ready-exited"].includes(state.mode)) {
        emit({ type: "terminal.ready" });
        return state.mode === "ready-invalid"
          ? { status: "running" }
          : { status: "exited", exitCode: 2, signal: null };
      }
      return await new Promise((resolve) => {
        state.pending.set(command.attachmentId, { resolve, emit, command });
        if (!["no-ready", "hold-ready"].includes(state.mode))
          emit({ type: "terminal.ready" });
      });
    }
    if (command.type === "terminal.detach") {
      if (state.relayDetachHolds > 0) {
        state.relayDetachHolds--;
        return await new Promise((resolve) => {
          state.relayDetachHeld = { resolve, command };
        });
      }
      if (state.detachFailures > 0) {
        state.detachFailures--;
        throw new Error("Controlled terminal detach failure");
      }
      state.pending.get(command.attachmentId)?.resolve({ status: "detached" });
      state.pending.delete(command.attachmentId);
      return null;
    }
    throw new Error("Unexpected terminal grant command");
  };
  return state;
}
async function until(read, label) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}
export async function terminalWorkerLinkCases({
  fixture,
  visit,
  state,
  result,
  profile,
  databaseMode,
  live,
}) {
  const start = result.commands.length;
  const session = await visit(
    "terminal WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "terminal-http-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`,
    route = (id) => `${base}/terminals/${id}/grant`;
  const operationId = "55555555-5555-4555-8555-555555555555",
    body = { operationId };
  for (const json of [
    undefined,
    null,
    {},
    [],
    { operationId: "bad" },
    { ...body, extra: true },
  ])
    await visit(
      "invalid terminal grant " + JSON.stringify(json),
      "POST",
      `/api/worker-links/55555555-5555-4555-8555-555555555555/terminals/missing/grant`,
      { json, status: 400 },
    );
  await visit(
    "unknown terminal grant session",
    "POST",
    "/api/worker-links/55555555-5555-4555-8555-555555555555/terminals/missing/grant",
    { json: body, status: 404 },
  );
  if (profile === "accounts")
    await visit(
      "foreign terminal grant session hidden",
      "POST",
      route("terminal"),
      { client: "other", json: body, status: 404 },
    );
  for (const [id, status] of [
    ["missing", 404],
    ["other-terminal", 404],
    ["run-terminal", 409],
    ["placement-terminal", 409],
  ])
    await visit("terminal grant resource " + id, "POST", route(id), {
      json: body,
      status,
    });
  const grant = async (label, id = "terminal") => {
    await live.ping();
    const eventStart = live.history.length;
    const at = result.commands.length;
    const value = await visit(label, "POST", route(id), {
      json: body,
      status: 201,
    });
    await live.ping();
    const publications = live.history
      .slice(eventStart)
      .filter(
        (e) =>
          e.type === "event" &&
          ["terminal", "project-tab-layout"].includes(e.resource),
      );
    assert.deepEqual(
      publications.map(
        ({ resource, scope, entityId, revision, payload, action }) => ({
          resource,
          scope,
          entityId,
          revision,
          payload,
          action,
        }),
      ),
      ["terminal", "terminal", "project-tab-layout"].map((resource) => ({
        resource,
        scope: { kind: "current-user" },
        entityId: id,
        revision: null,
        payload: null,
        action: "invalidated",
      })),
      label + " committed status and response invalidations",
    );
    workerLinkResourceGrantSchema.parse(value);
    assert.equal(value.binding.resource.kind, "terminal");
    assert.equal(value.binding.resource.resourceId, id);
    assert.equal(value.binding.resource.attachmentId, operationId);
    assert.deepEqual(value.binding.lanes, ["interactive"]);
    assert.deepEqual(value.binding.operations, [
      "stream:open",
      "stream:read",
      "stream:write",
    ]);
    assert.equal(value.binding.maxChannels, 1);
    const commands = result.commands.slice(at),
      open = commands.find((c) => c.type === "terminal.open"),
      detach = commands.find((c) => c.type === "terminal.detach"),
      installed = commands.find((c) => c.type === "worker-link.grant.install");
    assert.ok(open && detach && installed);
    assert.equal(open.attachmentId, detach.attachmentId);
    assert.equal(open.operationId, operationId);
    assert.equal(open.outputMode, "discard");
    assert.equal(open.cols, 80);
    assert.equal(open.rows, 24);
    assert.equal(
      installed.grant.tokenHash,
      createHash("sha256").update(value.token).digest("hex"),
    );
    assert.equal(installed.grant.token, undefined);
    await visit(
      "release " + label,
      "DELETE",
      `${base}/grants/${value.binding.grantId}`,
      { status: 204 },
    );
    return commands;
  };
  let commands = await grant("shell terminal grant");
  assert.deepEqual(commands.find((c) => c.type === "terminal.open").launch, {
    type: "shell",
  });
  commands = await grant("linked console grant", "linked-console");
  const ensure = commands.find((c) => c.type === "chat.thread.ensure"),
    open = commands.find((c) => c.type === "terminal.open");
  assert.ok(ensure);
  assert.equal(open.launch.type, "codex");
  assert.equal(open.launch.threadId, "http-console-thread");
  assert.ok(commands.indexOf(ensure) < commands.indexOf(open));
  commands = await grant("existing linked console grant", "linked-console");
  assert.equal(
    commands.some((c) => c.type === "chat.thread.ensure"),
    false,
  );
  state.mode = "ready-exited";
  await grant("exit after ready retains reference grant behavior");
  state.mode = "normal";
  for (const mode of [
    "open-error",
    "exited",
    "invalid-open",
    "ready-invalid",
    "grant-reject",
  ]) {
    state.mode = mode;
    const start = result.commands.length;
    await visit("terminal grant " + mode, "POST", route("terminal"), {
      json: body,
      status: mode === "grant-reject" ? 409 : 502,
    });
    const commands = result.commands.slice(start);
    assert.equal(
      commands.filter((c) => c.type === "terminal.detach").length,
      1,
    );
    state.mode = "normal";
  }
  if (databaseMode === "postgres") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    try {
      for (const deleted of [false, true]) {
        const terminal = deleted ? "disposable-terminal" : "terminal",
          at = result.commands.length;
        state.onInstall = async () => {
          if (deleted) await sql`DELETE FROM terminals WHERE id=${terminal}`;
          else
            await sql`UPDATE project_worktrees SET absolute_path='/fixture/changed-during-grant' WHERE id='github-alpha-main'`;
        };
        await visit(
          "terminal placement recheck " + (deleted ? "deleted" : "moved"),
          "POST",
          route(terminal),
          { json: body, status: 409 },
        );
        const revoked = result.commands
          .slice(at)
          .filter((c) => c.type === "worker-link.grant.revoke");
        assert.equal(revoked.length, 1);
        assert.equal(
          revoked[0].revocation.reason,
          deleted ? "resource-deleted" : "resource-stopped",
        );
        state.onInstall = undefined;
        await sql`UPDATE project_worktrees SET absolute_path='/fixture/github-alpha' WHERE id='github-alpha-main'`;
      }
    } finally {
      state.onInstall = undefined;
      await sql`UPDATE project_worktrees SET absolute_path='/fixture/github-alpha' WHERE id='github-alpha-main'`;
      await sql.end({ timeout: 5 });
    }
  }
  state.detachFailures = 1;
  let at = result.commands.length;
  await visit(
    "terminal grant detach failure cleanup",
    "POST",
    route("terminal"),
    { json: body, status: 502 },
  );
  assert.equal(
    result.commands.slice(at).filter((c) => c.type === "terminal.detach")
      .length,
    2,
  );
  if (profile === "none" && databaseMode === "pglite") {
    state.mode = "no-ready";
    const started = Date.now();
    await visit(
      "terminal grant actual startup timeout",
      "POST",
      route("terminal"),
      { json: body, status: 502, timeoutMs: 22000 },
    );
    assert.ok(Date.now() - started >= 14500);
    state.mode = "normal";
  }
  state.mode = "hold-ready";
  at = result.commands.length;
  const controller = new AbortController(),
    client = fixture.client(),
    promise = new Promise((resolve) => {
      // Own this disposable caller's socket. A global fetch pool may create
      // an unused replacement connection after abort, beyond this scenario.
      const request = httpRequest(
        fixture.server.origin + route("terminal"),
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
  const pending = await until(
    () => [...state.pending.values()][0],
    "actual terminal.open reached before abort",
  );
  controller.abort();
  assert.deepEqual(await promise, { error: "AbortError" });
  pending.emit({ type: "terminal.ready" });
  state.mode = "normal";
  await until(
    () =>
      result.commands
        .slice(at)
        .find((c) => c.type === "worker-link.grant.install"),
    "abandoned terminal grant installation remains owned",
  );
  await visit("release terminal WorkerLink session", "DELETE", base, {
    status: 204,
  });
  result.workerLinkCommands = fixture.normalize(result.commands.slice(start));
}
