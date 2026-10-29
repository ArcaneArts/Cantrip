// Actual lifecycle routes and coordinator acknowledgments, including failed moves.
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
export async function terminalWorktreeCases({
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
  const route = (id) => `/api/terminals/${id}/worktree`;
  const target = { worktreeId: "github-beta-main" };
  const move = async (label, id, json, status = 409, extra = {}) => {
    await live.ping();
    const at = live.history.length;
    const value = await visit(label, "PATCH", route(id), {
      json,
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
      label + " response invalidations",
    );
    events.push({ label, changes });
    return value;
  };
  for (const json of [
    undefined,
    null,
    [],
    {},
    { worktreeId: "" },
    { worktreeId: 1 },
  ])
    await move(
      "invalid worktree input " + JSON.stringify(json),
      "missing",
      json,
      400,
    );
  for (const id of ["missing", "other-terminal"])
    await move("hidden terminal move " + id, id, target, 404);
  await move(
    "worktree unknown keys are stripped",
    "missing",
    { ...target, extra: true },
    404,
  );
  await move(
    "worktree lone surrogate is a valid string",
    "lifecycle-terminal",
    { worktreeId: "\ud800" },
    404,
  );
  await move("run configuration move is read only", "run-terminal", target);
  await move("linked console inherits its chat", "linked-console", target);
  await move("folder project has no worktree capability", "folder-terminal", {
    worktreeId: "folder-beta-main",
  });
  await move(
    "wrong project worktree is hidden",
    "lifecycle-terminal",
    { worktreeId: "other-foreign-main" },
    404,
  );
  for (const [label, worktreeId, worker] of [
    ["move idle terminal across workers", "github-beta-main", "beta"],
    ["restore idle terminal placement", "github-alpha-main", "alpha"],
  ]) {
    const value = await move(label, "lifecycle-terminal", { worktreeId }, 200);
    assert.equal(value.worktreeId, worktreeId);
    assert.equal(value.activeWorkerId, worker);
  }
  const session = await visit(
    "lifecycle WorkerLink session",
    "POST",
    "/api/workers/alpha/worker-link/sessions",
    { json: { clientInstanceId: "terminal-lifecycle-client" }, status: 201 },
  );
  const base = `/api/worker-links/${session.sessionId}`;
  const grantPath = base + "/terminals/lifecycle-terminal/grant";
  const grantBody = { operationId: "55555555-5555-4555-8555-555555555551" };
  const issue = (label, status = 201) =>
    visit(label, "POST", grantPath, { json: grantBody, status });
  const renew = (label, grant, status) =>
    visit(label, "POST", `${base}/grants/${grant.binding.grantId}/renew`, {
      json: {},
      status,
    });
  const grant = await issue("lifecycle grant before failed move");
  let at = result.commands.length;
  await move("invalid mutation retains grant", "lifecycle-terminal", {}, 400);
  assert.equal(result.commands.length, at);
  await renew("grant survives invalid mutation", grant, 200);
  if (profile === "accounts") {
    await move(
      "foreign owner cannot revoke terminal grant",
      "lifecycle-terminal",
      target,
      404,
      { client: "other" },
    );
    await renew("grant survives foreign mutation", grant, 200);
  }
  at = result.commands.length;
  const rejected = await move(
    "running move still revokes existing grant",
    "lifecycle-terminal",
    target,
  );
  assert.equal(
    rejected.error,
    "Stop the terminal before changing its worktree.",
  );
  const revoked = result.commands
    .slice(at)
    .filter((c) => c.type === "worker-link.grant.revoke");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].grantId, grant.binding.grantId);
  assert.equal(revoked[0].revocation.reason, "resource-stopped");
  await renew("failed move revoked the prior grant", grant, 409);

  // Revoke an installation while the actual worker acknowledgment is pending.
  let releaseInstall,
    enteredInstall = false;
  state.onInstall = async () => {
    enteredInstall = true;
    await new Promise((resolve) => {
      releaseInstall = resolve;
    });
  };
  at = result.commands.length;
  const pendingGrant = issue(
    "pending installation loses authority to mutation",
    409,
  );
  try {
    await until(() => enteredInstall, "grant install reached worker");
    await move(
      "mutation revokes pending installation",
      "lifecycle-terminal",
      target,
    );
  } finally {
    releaseInstall?.();
    state.onInstall = undefined;
  }
  await pendingGrant;
  assert.deepEqual(
    result.commands
      .slice(at)
      .filter((c) => c.type === "worker-link.grant.revoke")
      .map((c) => c.revocation.reason),
    ["resource-stopped", "released"],
  );

  if (databaseMode === "postgres") {
    const sql = postgres(fixture.environment.DATABASE_URL, { max: 1 });
    let releaseRevoke;
    try {
      await issue("grant for caller-aborted move");
      await sql`UPDATE terminals SET status='offline' WHERE id='lifecycle-terminal'`;
      let enteredRevoke = false;
      state.onRevoke = async () => {
        enteredRevoke = true;
        await new Promise((resolve) => {
          releaseRevoke = resolve;
        });
      };
      const controller = new AbortController(),
        client = fixture.client();
      const aborted = new Promise((resolve) => {
        const request = httpRequest(
          fixture.server.origin + route("lifecycle-terminal"),
          {
            method: "PATCH",
            signal: controller.signal,
            agent: false,
            headers: {
              origin: "http://127.0.0.1:5173",
              "content-type": "application/json",
              connection: "close",
              ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
            },
          },
          (response) => {
            response.resume();
            resolve({ status: response.statusCode });
          },
        );
        request.on("error", (error) => resolve({ error: error.name }));
        request.end(JSON.stringify(target));
      });
      await until(
        () => enteredRevoke,
        "move waits for actual revocation acknowledgment",
      );
      controller.abort();
      assert.deepEqual(await aborted, { error: "AbortError" });
      releaseRevoke();
      state.onRevoke = undefined;
      await until(
        async () =>
          (
            await sql`SELECT active_worker_id FROM terminals WHERE id='lifecycle-terminal'`
          )[0]?.active_worker_id === "beta",
        "admitted mutation writes after caller abort",
      );
      await move(
        "restore placement after aborted request",
        "lifecycle-terminal",
        { worktreeId: "github-alpha-main" },
        200,
      );
      await sql`ALTER TABLE terminals ADD CONSTRAINT lifecycle_move_reject CHECK (id <> 'lifecycle-terminal' OR active_worker_id <> 'beta') NOT VALID`;
      const failed = await move(
        "actual placement write failure retains source SQL error",
        "lifecycle-terminal",
        target,
      );
      assert.match(
        failed.error,
        /^Failed query: update "terminals" set "active_worker_id"/,
      );
      assert.equal(
        (
          await sql`SELECT active_worker_id FROM terminals WHERE id='lifecycle-terminal'`
        )[0].active_worker_id,
        "alpha",
      );
      await sql`ALTER TABLE terminals DROP CONSTRAINT lifecycle_move_reject`;
    } finally {
      releaseRevoke?.();
      state.onRevoke = undefined;
      await sql`ALTER TABLE terminals DROP CONSTRAINT IF EXISTS lifecycle_move_reject`;
      await sql.end({ timeout: 5 });
    }
  }
  await visit("release lifecycle WorkerLink session", "DELETE", base, {
    status: 204,
  });
  result.terminalLifecycleCommands = fixture.normalize(
    result.commands.slice(start),
  );
  result.terminalLifecycleEvents = events;
}
