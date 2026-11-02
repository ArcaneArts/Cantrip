import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
import { runTaskDispatchLeaseRaces } from "./task-dispatch-lease-races.mjs";
export async function runTaskDispatchLeaseCases(h) {
  const { observe, seed } = h;
  const cycle = "77777777-7777-4777-8777-000000000001",
    fence = {
      cycleId: cycle,
      operationId: "lease-operation",
      leaseOwner: "lease-owner",
      fencingToken: 1,
    };
  await seed(
    "INSERT INTO tasks(chat_id,protected_content) VALUES('task','{}'::jsonb) ON CONFLICT DO NOTHING",
  );
  const reset = () =>
    seed([
      "DELETE FROM task_dispatch_cycles",
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,lease_owner,lease_expires_at,fencing_token,queued_at,claimed_at,created_at,updated_at) SELECT '${cycle}',owner_id,'task','lease-operation','direct','claimed',${literal(stamp)},'lease-owner',${literal(stamp)}::timestamptz+interval '2 minutes',1,${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)} FROM chats WHERE id='task'`,
    ]);
  const run = (name, action, fields = {}, options = {}) =>
    observe(
      name,
      { action, fence, options: { now: stamp }, ...fields },
      { op: "native-command-task-lease", shape: "raw", ...options },
    );
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_agg(to_jsonb(c) ORDER BY id) result FROM task_dispatch_cycles c",
      },
      { op: "query-json", shape: "raw" },
    );
  await reset();
  let values = await run(
    "Task launch persists running under its exact active fence",
    "running",
    {
      options: {
        now: stamp,
        turnId: "initial-turn",
        affinity: {
          worktreeId: "github-alpha-main",
          threadId: "affinity-thread",
          modelRouteId: "gui-anchor",
          providerAccountId: null,
        },
      },
    },
  );
  for (const value of values) {
    assert.equal(value.state, "running");
    assert.equal(value.startedAt, stamp);
    assert.equal(value.codexThreadId, "affinity-thread");
    assert.equal(value.turnId, "initial-turn");
  }
  values = await run(
    "repeated Task running retains its original start and absent turn",
    "running",
  );
  for (const value of values) {
    assert.equal(value.turnId, "initial-turn");
    assert.equal(value.startedAt, stamp);
  }
  values = await run(
    "explicit null Task turn clears only the supplied affinity field",
    "running",
    { options: { now: stamp, turnId: null, affinity: { modelRouteId: null } } },
  );
  for (const value of values) {
    assert.equal(value.turnId, null);
    assert.equal(value.modelRouteId, null);
    assert.equal(value.codexThreadId, "affinity-thread");
    assert.equal(value.worktreeId, "github-alpha-main");
  }
  values = await run(
    "heartbeat extends the actual lease and returns the worker fence",
    "heartbeat",
    { options: { now: stamp, leaseMs: 180000 } },
  );
  for (const value of values)
    assert.deepEqual(value, {
      ...fence,
      leaseExpiresAt: new Date(Date.parse(stamp) + 180000).toISOString(),
    });
  await snapshot("Task lease changes are durable");
  for (const leaseMs of [0, -1, 1.5, 9007199254740992])
    await run(
      "invalid Task lease duration " + leaseMs,
      "heartbeat",
      { options: { now: stamp, leaseMs } },
      { error: true },
    );
  for (const [name, patch] of [
    ["cycle", { cycleId: "77777777-7777-4777-8777-000000000002" }],
    ["operation", { operationId: "another" }],
    ["owner", { leaseOwner: "another" }],
    ["token", { fencingToken: 2 }],
  ]) {
    const before = await snapshot("before mismatched Task fence " + name);
    await run(
      "Task launch rejects mismatched " + name,
      "running",
      { fence: { ...fence, ...patch } },
      { error: true },
    );
    assert.deepEqual(await snapshot("unchanged Task fence " + name), before);
  }
  for (const state of [
    "queued",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]) {
    await reset();
    await seed(`UPDATE task_dispatch_cycles SET state='${state}'`);
    await run(
      "Task launch refuses state " + state,
      "running",
      {},
      { error: true },
    );
    await run(
      "Task heartbeat refuses state " + state,
      "heartbeat",
      {},
      { error: true },
    );
  }
  await reset();
  await seed(
    `UPDATE task_dispatch_cycles SET lease_expires_at=${literal(stamp)}`,
  );
  await run(
    "Task lease expires at exact equality with operation time",
    "running",
    {},
    { error: true },
  );
  await reset();
  values = await run(
    "pausing unstarted preflight advances its durable fencing token",
    "pause-unstarted",
    { affinity: { threadId: "paused-thread", turnId: null } },
  );
  for (const value of values) {
    assert.equal(value.state, "paused");
    assert.equal(value.fencingToken, 2);
    assert.equal(value.startedAt, null);
  }
  await run(
    "late Task preflight cannot cross a paused fence",
    "running",
    {},
    { error: true },
  );
  await run(
    "late Task heartbeat cannot renew a paused fence",
    "heartbeat",
    {},
    { error: true },
  );
  await snapshot("paused preflight fence remains authoritative");
  await reset();
  await run("running Task before pause", "running");
  await run(
    "unstarted pause refuses an already started Task",
    "pause-unstarted",
    { affinity: { threadId: null, turnId: null } },
    { error: true },
  );
  values = await run(
    "running pause retains its existing continuation fence",
    "pause",
    { affinity: { threadId: "continuation", turnId: "paused-turn" } },
  );
  for (const value of values) {
    assert.equal(value.state, "paused");
    assert.equal(value.fencingToken, 1);
    assert.equal(value.codexThreadId, "continuation");
  }
  values = await run(
    "paused Task settles under the same unexpired fence",
    "settle",
    { state: "succeeded" },
  );
  for (const value of values) {
    assert.equal(value.state, "succeeded");
    assert.equal(value.completedAt, stamp);
  }
  await run(
    "settled Task cannot be completed twice",
    "settle",
    { state: "failed" },
    { error: true },
  );
  await snapshot("Task settlement is durable and fenced");
  if (h.databaseMode === "postgres")
    await runTaskDispatchLeaseRaces(h, reset, fence);
  await seed("DELETE FROM task_dispatch_cycles");
}
