import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
async function until(read, label) {
  const end = Date.now() + 12000;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}
export async function terminalDeleteCases({
  fixture,
  visit,
  state,
  result,
  profile,
  databaseMode,
  live,
}) {
  const start = result.commands.length,
    events = [];
  const remove = async (label, id, status = 204, extra = {}) => {
    await live.ping();
    const at = live.history.length;
    const value = await visit(label, "DELETE", `/api/terminals/${id}`, {
      status,
      ...extra,
    });
    await live.ping();
    const changes = live.history
      .slice(at)
      .filter(
        (e) =>
          e.type === "event" &&
          ["terminal", "project-tab-layout"].includes(e.resource),
      )
      .map(({ resource, scope, entityId, revision, payload, action }) => ({
        resource,
        scope,
        entityId,
        revision,
        payload,
        action,
      }));
    assert.deepEqual(
      changes,
      status < 400
        ? ["terminal", "project-tab-layout"].map((resource) => ({
            resource,
            scope: { kind: "current-user" },
            entityId: id,
            revision: null,
            payload: null,
            action: "invalidated",
          }))
        : [],
      label + " committed response invalidations",
    );
    events.push({ label, changes });
    return value;
  };
  for (const id of ["missing", "other-terminal"])
    await remove("delete hidden resource " + id, id, 404, {
      json: { extra: true },
    });
  const session = await visit(
    "deletion WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "terminal-deletion-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`;
  const issue = (label, id = "lifecycle-terminal", status = 201) =>
    visit(label, "POST", `${base}/terminals/${id}/grant`, {
      json: { operationId: "55555555-5555-4555-8555-555555555552" },
      status,
    });
  const first = await issue("first grant before deletion"),
    second = await issue("second grant before deletion");
  if (profile === "accounts") {
    await remove(
      "foreign delete cannot revoke owning grants",
      "lifecycle-terminal",
      404,
      { client: "other" },
    );
    await visit(
      "grant survives foreign delete",
      "POST",
      `${base}/grants/${first.binding.grantId}/renew`,
      { json: {}, status: 200 },
    );
  }
  let releaseInstall,
    entered = false;
  state.onInstall = async () => {
    entered = true;
    await new Promise((resolve) => {
      releaseInstall = resolve;
    });
  };
  let at = result.commands.length;
  const pending = issue(
    "pending grant loses authority to deletion",
    "lifecycle-terminal",
    409,
  );
  try {
    await until(() => entered, "pending grant reached worker");
    await remove(
      "delete terminal with acknowledged and pending grants",
      "lifecycle-terminal",
    );
  } finally {
    releaseInstall?.();
    state.onInstall = undefined;
  }
  await pending;
  const commands = result.commands.slice(at),
    revoked = commands.filter((c) => c.type === "worker-link.grant.revoke");
  assert.deepEqual(
    revoked.map((c) => c.revocation.reason),
    ["resource-deleted", "resource-deleted", "resource-deleted", "released"],
  );
  assert.ok(revoked.some((c) => c.grantId === first.binding.grantId));
  assert.ok(revoked.some((c) => c.grantId === second.binding.grantId));
  const close = commands.findIndex((c) => c.type === "terminal.close");
  assert.ok(
    close > commands.findIndex((c) => c.type === "worker-link.grant.revoke"),
  );
  await remove("repeated terminal delete", "lifecycle-terminal", 404);
  await issue(
    "deleted terminal cannot issue a grant",
    "lifecycle-terminal",
    404,
  );
  state.mode = "close-error";
  await remove(
    "worker close failure retains committed deletion",
    "delete-failure-terminal",
  );
  state.mode = "normal";
  await remove(
    "failed worker close cannot resurrect terminal",
    "delete-failure-terminal",
    404,
  );
  await issue("grant for aborted deletion", "delete-abort-terminal");
  let releaseRevoke,
    enteredRevoke = false;
  state.onRevoke = async () => {
    enteredRevoke = true;
    await new Promise((resolve) => {
      releaseRevoke = resolve;
    });
  };
  at = result.commands.length;
  const controller = new AbortController(),
    client = fixture.client();
  const aborted = new Promise((resolve) => {
    const request = httpRequest(
      fixture.server.origin + "/api/terminals/delete-abort-terminal",
      {
        method: "DELETE",
        signal: controller.signal,
        agent: false,
        headers: {
          origin: "http://127.0.0.1:5173",
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
    request.end();
  });
  try {
    await until(
      () => enteredRevoke,
      "delete waits for actual revocation acknowledgment",
    );
    controller.abort();
    assert.deepEqual(await aborted, { error: "AbortError" });
  } finally {
    releaseRevoke?.();
    state.onRevoke = undefined;
  }
  await until(
    () =>
      result.commands
        .slice(at)
        .some(
          (c) =>
            c.type === "terminal.close" &&
            c.terminalId === "delete-abort-terminal",
        ),
    "committed deletion and worker close survive caller abort",
  );
  await visit(
    "aborted delete retained durable result",
    "DELETE",
    "/api/terminals/delete-abort-terminal",
    { status: 404 },
  );
  if (databaseMode === "postgres") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    try {
      await sql`UPDATE run_configuration_runtimes SET terminal_id='delete-error-terminal' WHERE terminal_id='run-terminal'`;
      await sql`ALTER TABLE run_configuration_runtimes ADD CONSTRAINT lifecycle_runtime_clear_blocker CHECK(terminal_id IS NOT NULL) NOT VALID`;
      const failedClear = await remove(
        "runtime clear failure rolls back ownership cleanup",
        "delete-error-terminal",
        409,
      );
      assert.match(
        failedClear.error,
        /^Failed query: update "run_configuration_runtimes" set "terminal_id"/,
      );
      assert.equal(
        (
          await sql`SELECT (layout->>'revision')::integer revision FROM workspace_layouts WHERE workspace_id='http-delete-error'`
        )[0].revision,
        4,
      );
      await sql`ALTER TABLE run_configuration_runtimes DROP CONSTRAINT lifecycle_runtime_clear_blocker`;
      await sql`CREATE TABLE lifecycle_delete_blocker(terminal_id text REFERENCES terminals(id) ON DELETE RESTRICT)`;
      await sql`INSERT INTO lifecycle_delete_blocker VALUES('delete-error-terminal')`;
      const failure = await remove(
        "actual DELETE failure rolls back all cleanup",
        "delete-error-terminal",
        409,
      );
      assert.match(
        failure.error,
        /^Failed query: delete from "terminals" where "terminals"\."id" = \$1\nparams: delete-error-terminal$/,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::integer n FROM terminals WHERE id='delete-error-terminal'`
        )[0].n,
        1,
      );
      await sql`DROP TABLE lifecycle_delete_blocker`;
      await remove(
        "retry deletion after reference release",
        "delete-error-terminal",
      );
    } finally {
      await sql`ALTER TABLE run_configuration_runtimes DROP CONSTRAINT IF EXISTS lifecycle_runtime_clear_blocker`;
      await sql`UPDATE run_configuration_runtimes SET terminal_id='run-terminal' WHERE terminal_id='delete-error-terminal'`;
      await sql`DROP TABLE IF EXISTS lifecycle_delete_blocker`;
      await sql.end({ timeout: 5 });
    }
  }
  await visit("release deletion WorkerLink session", "DELETE", base, {
    status: 204,
  });
  result.terminalDeleteCommands = fixture.normalize(
    result.commands.slice(start),
  );
  result.terminalDeleteEvents = events;
}
