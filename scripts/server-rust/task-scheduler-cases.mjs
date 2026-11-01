import assert from "node:assert/strict";
import {
  literal,
  json,
  label,
  stamp,
  otherOwner,
} from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
import { runTaskSchedulerRaces } from "./task-scheduler-races.mjs";
export async function runTaskSchedulerCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
  const worker = id(101),
    second = id(102),
    foreign = id(103),
    chats = ["task", "scheduler-next", "scheduler-third"];
  const eligible = {
    eligible: true,
    modelRouteId: "scheduler-route",
    providerAccountId: null,
    codexThreadId: "retained-thread",
  };
  for (let i = 1; i < 3; i++)
    h.registerFixedClock(Date.parse(stamp) + i * 1000);
  const run = (name, action, fields = {}, options = {}) =>
    observe(
      name,
      typeof fields === "function"
        ? (i) => ({
            action,
            leaseOwner: "scheduler-owner",
            options: { now: stamp },
            resolution: eligible,
            ...fields(i),
          })
        : {
            action,
            leaseOwner: "scheduler-owner",
            options: { now: stamp },
            resolution: eligible,
            ...fields,
          },
      { op: "native-command-task-scheduler", shape: "raw", ...options },
    );
  async function ok(name, action, fields = {}, check = () => {}) {
    const values = await run(name, action, fields);
    for (const v of values) {
      assert.ok(Object.hasOwn(v, "value"), name + JSON.stringify(v));
      check(v.value, v.trace);
    }
    return values.map((v) => v.value);
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY fifo_created_at,chat_id,operation_id,id) FROM task_dispatch_cycles c),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'workers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM task_workers w)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  async function conflict(
    name,
    action,
    fields,
    code,
    message,
    kind = "conflict",
  ) {
    const before = await snapshot("before " + name);
    const values = await run(name, action, fields);
    for (const v of values)
      assert.deepEqual(v.error, { kind, code, message }, name);
    assert.deepEqual(await snapshot("unchanged " + name), before);
  }
  async function clean(statements = []) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL",
      "UPDATE workers SET unlinked_at=NULL",
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('scheduler-model',${literal(owner)},'Scheduler model'),('scheduler-foreign-model',${literal(otherOwner)},'Foreign scheduler model') ON CONFLICT DO NOTHING`,
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('scheduler-provider',${literal(owner)},'Scheduler provider','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,enabled) VALUES('scheduler-route','scheduler-model','scheduler-provider','fixture',true) ON CONFLICT DO NOTHING",
      ...chats
        .slice(1)
        .map(
          (chat) =>
            `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(chat)},${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET archived_at=NULL,active_worker_id='alpha',active_worktree_id='github-alpha-main'`,
        ),
      ...chats.map(
        (chat, i) =>
          `INSERT INTO tasks(chat_id,protected_content,created_at,updated_at,priority) VALUES(${literal(chat)},${json(taskEnvelope)},${literal(stamp)}::timestamptz+interval '${i} seconds',${literal(stamp)},${i * 100})`,
      ),
      `INSERT INTO task_workers(id,owner_id,name,model_id,allows_plan_goal,continuity_family,position,created_at,updated_at) VALUES('${worker}',${literal(owner)},'First','scheduler-model',true,'family-a',0,${literal(stamp)},${literal(stamp)}),('${second}',${literal(owner)},'Second','scheduler-model',true,'family-b',1,${literal(stamp)},${literal(stamp)}),('${foreign}',${literal(otherOwner)},'Foreign','scheduler-foreign-model',true,'family-a',0,${literal(stamp)},${literal(stamp)})`,
      ...statements,
    ]);
  }
  const enqueue = (
    chat = "task",
    operation = "dispatch-operation",
    kind = "direct",
    rowVersion = 1,
  ) =>
    ok(
      "enqueue " + chat + " " + operation,
      "enqueue",
      { chat, operation, kind, rowVersion },
      (v) => {
        assert.equal(v.state, "queued");
        assert.equal(v.fencingToken, 0);
        assert.equal(v.attemptCount, 0);
      },
    );
  const claim = (
    name = "claim oldest eligible Task",
    fields = {},
    check = () => {},
  ) => ok(name, "claim", fields, check);
  await clean([
    `UPDATE tasks SET created_at=${literal(stamp)}::timestamptz+interval '123 microseconds' WHERE chat_id='task'`,
  ]);
  await enqueue("task", "submillisecond-fifo");
  await snapshot("FIFO timestamp preserves Source Date precision");
  await clean();
  await ok("missing cycle is null", "get", { cycle: "missing" }, (v) =>
    assert.equal(v, null),
  );
  await ok("empty dispatch list", "list", {}, (v) => assert.deepEqual(v, []));
  await ok("no scheduler owners without cycles", "owners", {}, (v) =>
    assert.deepEqual(v, []),
  );
  for (let mask = 0; mask < 16; mask++) {
    const schedulerOwner = {
      ownerId: owner,
      hasClaimed: Boolean(mask & 1),
      hasRunning: Boolean(mask & 2),
      hasPaused: Boolean(mask & 4),
      hasQueued: Boolean(mask & 8),
    };
    await ok("scheduler plan " + mask, "plan", { schedulerOwner }, (v) =>
      assert.deepEqual(v, {
        reconcileUnstartedClaims: schedulerOwner.hasClaimed,
        reconcileStartedLeases:
          schedulerOwner.hasClaimed || schedulerOwner.hasRunning,
        resumePaused: schedulerOwner.hasPaused,
        claimQueued: schedulerOwner.hasQueued,
      }),
    );
  }
  await conflict(
    "missing owner cannot enqueue",
    "enqueue",
    {
      owner: "missing-owner",
      chat: "task",
      operation: "missing",
      kind: "direct",
      rowVersion: 1,
    },
    null,
    "Task not found.",
    "not-found",
  );
  await conflict(
    "foreign principal cannot enqueue Task",
    "enqueue",
    {
      owner: otherOwner,
      chat: "task",
      operation: "foreign",
      kind: "direct",
      rowVersion: 1,
    },
    null,
    "Task not found.",
    "not-found",
  );
  await conflict(
    "enqueue validates row version",
    "enqueue",
    { chat: "task", operation: "stale", kind: "direct", rowVersion: 2 },
    "stale-version",
    "The Task changed in another client.",
  );
  await conflict(
    "disabled Plan Goal rejects planning enqueue",
    "enqueue",
    { chat: "task", operation: "plan", kind: "initial-plan", rowVersion: 1 },
    "idempotency-conflict",
    "Enable Plan + Goal before queueing a planning operation.",
  );
  for (const operation of ["", " \ufeff\n ", "a".repeat(201), "🦀".repeat(101)])
    await run(
      "invalid UTF16 operation identity " + JSON.stringify(operation),
      "enqueue",
      { chat: "task", operation, kind: "direct", rowVersion: 1 },
      { error: true },
    );
  let cycles = await enqueue();
  await ok("owner scheduler flags detect queued cycle", "owners", {}, (v) =>
    assert.deepEqual(v, [
      {
        ownerId: owner,
        hasQueued: true,
        hasClaimed: false,
        hasRunning: false,
        hasPaused: false,
      },
    ]),
  );
  await ok(
    "foreign cycle read is null",
    "get",
    (i) => ({ owner: otherOwner, cycle: cycles[i].id }),
    (v) => assert.equal(v, null),
  );
  let before = await snapshot("before enqueue replay");
  await ok(
    "same operation replays before checking stale Task version",
    "enqueue",
    {
      chat: "task",
      operation: "dispatch-operation",
      kind: "direct",
      rowVersion: 999,
    },
    (v) => assert.equal(v.state, "queued"),
  );
  assert.deepEqual(await snapshot("replayed enqueue does not write"), before);
  await conflict(
    "same operation cannot change kind",
    "enqueue",
    {
      chat: "task",
      operation: "dispatch-operation",
      kind: "goal-continuation",
      rowVersion: 1,
    },
    "idempotency-conflict",
    "This Task operation ID was already used for another operation.",
  );
  await conflict(
    "another operation cannot overtake queued Task",
    "enqueue",
    {
      chat: "task",
      operation: "second-operation",
      kind: "direct",
      rowVersion: 1,
    },
    "active-operation",
    "The Task already has an active scheduled operation.",
  );
  let claimed = await claim(undefined, {}, (v, trace) => {
    assert.equal(v.cycle.chatId, "task");
    assert.equal(v.cycle.state, "claimed");
    assert.equal(v.cycle.selectedTaskWorkerId, worker);
    assert.equal(v.cycle.fencingToken, 1);
    assert.equal(v.taskWorker.activeTaskCount, 0);
    assert.equal(trace.length, 1);
    assert.equal(v.lease.leaseOwner, "scheduler-owner");
  });
  let state = await snapshot(
    "claim persists affinity and continuity without changing Task row version",
  );
  for (const v of state) {
    const task = v.tasks.find((t) => t.chat_id === "task");
    assert.equal(task.row_version, 1);
    assert.equal(task.scheduler_revision, 2);
    assert.equal(task.last_task_worker_id, worker);
    assert.equal(task.continuity_family, "family-a");
  }
  await ok(
    "mark claimed operation running",
    "running",
    (i) => ({
      fence: claimed[i].lease,
      turnId: "ignored",
      options: { now: stamp, turnId: "first-turn" },
    }),
    (v) => {
      assert.equal(v.state, "running");
      assert.equal(v.turnId, "first-turn");
    },
  );
  await ok(
    "settle first dispatch",
    "settle",
    (i) => ({ fence: claimed[i].lease, state: "failed" }),
    (v) => assert.equal(v.state, "failed"),
  );
  cycles = await ok(
    "terminal operation requeues with same FIFO identity and newer fence",
    "enqueue",
    {
      chat: "task",
      operation: "dispatch-operation",
      kind: "direct",
      rowVersion: 1,
    },
    (v) => {
      assert.equal(v.state, "queued");
      assert.equal(v.fencingToken, 2);
      assert.equal(v.attemptCount, 1);
      assert.equal(v.startedAt, null);
      assert.equal(v.codexThreadId, null);
      assert.equal(v.selectedTaskWorkerId, null);
    },
  );
  await reopen("queued dispatch survives process reopen");
  await ok(
    "reopened cycle retains attempted count",
    "get",
    (i) => ({ cycle: cycles[i].id }),
    (v) => assert.equal(v.attemptCount, 1),
  );

  await clean();
  await enqueue("scheduler-next", "newer");
  await enqueue("task", "older");
  claimed = await claim(
    "FIFO wins over enqueue order and Task priority",
    {},
    (v) => assert.equal(v.cycle.chatId, "task"),
  );
  let next = await claim(
    "next worker can claim next Task while first is full",
    {},
    (v) => {
      assert.equal(v.cycle.chatId, "scheduler-next");
      assert.equal(v.cycle.selectedTaskWorkerId, second);
    },
  );
  await enqueue("scheduler-third", "third");
  await claim("all full workers retain queue and capacity reason", {}, (v) =>
    assert.equal(v, null),
  );
  state = await snapshot("full capacity is durable");
  for (const v of state)
    assert.equal(
      v.cycles.find((c) => c.chat_id === "scheduler-third").eligibility_code,
      "capacity-unavailable",
    );
  await ok(
    "pause frees first worker capacity while retaining affinity",
    "pause",
    (i) => ({
      fence: claimed[i].lease,
      affinity: { threadId: "paused-thread", turnId: "paused-turn" },
    }),
    (v) => {
      assert.equal(v.state, "paused");
      assert.equal(v.codexThreadId, "paused-thread");
    },
  );
  let resumed = await ok(
    "paused dispatch resumes under retained owner and fence",
    "resume",
    { leaseOwner: "different-server" },
    (v, trace) => {
      assert.equal(v.cycle.chatId, "task");
      assert.equal(v.cycle.leaseOwner, "scheduler-owner");
      assert.equal(v.cycle.fencingToken, 1);
      assert.equal(v.cycle.attemptCount, 2);
      assert.equal(v.cycle.codexThreadId, "paused-thread");
      assert.equal(v.taskWorker.activeTaskCount, 1);
      assert.equal(trace.length, 1);
    },
  );
  await conflict(
    "capacity deferral rejects a cycle with a dispatched turn",
    "defer",
    (i) => ({ fence: resumed[i].lease }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );

  const blockedCases = [
    [
      "no enabled owned Task workers",
      [
        "UPDATE task_workers SET enabled=false WHERE owner_id=" +
          literal(owner),
      ],
      "task-worker-disabled",
    ],
    [
      "project scheduling paused",
      [
        "UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25T00:00:00.123Z' WHERE id='github'",
      ],
      "project-paused",
    ],
    [
      "continuity family cannot silently change",
      ["UPDATE tasks SET continuity_family='unmatched' WHERE chat_id='task'"],
      "continuity-mismatch",
    ],
    [
      "worktree not ready",
      [
        "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
      ],
      "placement-unavailable",
    ],
    [
      "physical worker unlinked",
      [`UPDATE workers SET unlinked_at=${literal(stamp)} WHERE id='alpha'`],
      "placement-unavailable",
    ],
    [
      "explicit assignment to foreign Task worker does not match owned workers",
      [
        `UPDATE tasks SET requested_task_worker_id='${foreign}' WHERE chat_id='task'`,
      ],
      null,
    ],
    [
      "archived Task stays queued",
      [`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='task'`],
      null,
    ],
  ];
  for (const [name, sql, reason] of blockedCases) {
    await clean(sql);
    await enqueue();
    await claim(name, {}, (value, trace) => {
      assert.equal(value, null);
      assert.deepEqual(trace, []);
    });
    state = await snapshot("reason for " + name);
    for (const s of state) {
      assert.equal(s.cycles[0].state, "queued");
      assert.equal(s.cycles[0].eligibility_code, reason);
    }
  }
  await clean([
    "UPDATE tasks SET plan_goal_enabled=true WHERE chat_id='task'",
    "UPDATE task_workers SET allows_plan_goal=false WHERE owner_id=" +
      literal(owner),
  ]);
  await enqueue("task", "plan-operation", "initial-plan");
  await claim("Plan Goal support is required for planning", {}, (v) =>
    assert.equal(v, null),
  );
  state = await snapshot("Plan Goal unsupported reason");
  for (const s of state)
    assert.equal(s.cycles[0].eligibility_code, "plan-goal-unsupported");

  for (const laneState of ["active", "delivering"]) {
    await clean([
      `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,state,created_at,updated_at) VALUES('${id(120)}','task','alpha','github-alpha-main','fixture',${literal(laneState)},${literal(stamp)},${literal(stamp)})`,
    ]);
    await enqueue();
    await claim(
      "existing " + laneState + " execution is not duplicated",
      {},
      (v, trace) => {
        assert.equal(v, null);
        assert.deepEqual(trace, []);
      },
    );
    state = await snapshot("lane keeps original eligibility diagnostic");
    for (const s of state) assert.equal(s.cycles[0].eligibility_code, null);
  }
  await clean([
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,state,created_at,updated_at) VALUES('${id(120)}','scheduler-next','alpha','github-alpha-main','fixture','active',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,created_at,updated_at) VALUES('${id(121)}','github','main','${id(120)}','github-alpha-main','alpha',${literal(stamp)},${literal(stamp)})`,
  ]);
  await enqueue();
  await claim(
    "another chat retains exclusive branch capacity",
    {},
    (v, trace) => {
      assert.equal(v, null);
      assert.deepEqual(trace, []);
    },
  );
  state = await snapshot("branch lease capacity reason");
  for (const s of state)
    assert.equal(s.cycles[0].eligibility_code, "capacity-unavailable");

  await clean([
    `UPDATE tasks SET requested_task_worker_id='${second}',continuity_family='retained-family' WHERE chat_id='task'`,
  ]);
  await enqueue();
  await claim(
    "explicit worker bypasses family matching while preserving Task continuity",
    {},
    (v) => {
      assert.equal(v.cycle.selectedTaskWorkerId, second);
      assert.equal(v.cycle.continuityFamily, "family-b");
    },
  );
  state = await snapshot(
    "explicit assignment does not overwrite Task continuity",
  );
  for (const s of state)
    assert.equal(
      s.tasks.find((t) => t.chat_id === "task").continuity_family,
      "retained-family",
    );
  await clean([
    `UPDATE tasks SET requested_task_worker_id='${second}' WHERE chat_id='task'`,
    `UPDATE tasks SET requested_task_worker_id='${worker}' WHERE chat_id='scheduler-next'`,
  ]);
  await enqueue("task", "older-assigned");
  await enqueue("scheduler-next", "newer-assigned");
  await claim(
    "worker position precedes FIFO across different assigned workers",
    {},
    (v) => {
      assert.equal(v.cycle.chatId, "scheduler-next");
      assert.equal(v.cycle.selectedTaskWorkerId, worker);
    },
  );
  await clean();
  await enqueue();
  await enqueue("scheduler-next", "next");
  await claim(
    "eligible later candidate does not persist provisional earlier rejection",
    {
      resolutions: [
        {
          chat: "task",
          result: { eligible: false, code: "model-unavailable" },
        },
      ],
    },
    (v, trace) => {
      assert.equal(v.cycle.chatId, "scheduler-next");
      assert.deepEqual(
        trace.map((v) => v.cycle.chatId),
        ["task", "scheduler-next"],
      );
    },
  );
  state = await snapshot(
    "successful claim preserves earlier candidate diagnostic",
  );
  for (const s of state)
    assert.equal(
      s.cycles.find((c) => c.chat_id === "task").eligibility_code,
      null,
    );
  await clean();
  await enqueue();
  before = await snapshot("before resolver failure");
  await run(
    "eligibility exception leaves transaction unchanged",
    "claim",
    { failEligibility: true },
    { error: true },
  );
  assert.deepEqual(await snapshot("resolver failure leaves no claim"), before);
  await claim(
    "resolver rejection persists last eligibility reason",
    { resolution: { eligible: false, code: "worker-offline" } },
    (v, trace) => {
      assert.equal(v, null);
      assert.equal(trace.length, 2);
    },
  );
  state = await snapshot("resolver worker offline reason");
  for (const s of state)
    assert.equal(s.cycles[0].eligibility_code, "worker-offline");

  await clean();
  await enqueue();
  claimed = await claim();
  await ok(
    "capacity deferral requeues unlaunched claim and advances fence",
    "defer",
    (i) => ({ fence: claimed[i].lease }),
    (v) => {
      assert.equal(v.state, "queued");
      assert.equal(v.fencingToken, 2);
      assert.equal(v.attemptCount, 1);
      assert.equal(v.codexThreadId, null);
      assert.equal(v.eligibilityCode, "capacity-unavailable");
    },
  );
  await conflict(
    "deferred fence cannot launch",
    "running",
    (i) => ({ fence: claimed[i].lease }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );
  claimed = await claim("reclaim deferred cycle", {}, (v) => {
    assert.equal(v.cycle.fencingToken, 3);
    assert.equal(v.cycle.attemptCount, 2);
  });
  await ok(
    "pause unstarted invalidates old launch fence",
    "pause-unstarted",
    (i) => ({
      fence: claimed[i].lease,
      affinity: { threadId: "retained", turnId: null },
    }),
    (v) => {
      assert.equal(v.state, "paused");
      assert.equal(v.fencingToken, 4);
    },
  );
  await conflict(
    "pre-pause launch fence stays stale after resume",
    "running",
    (i) => ({ fence: claimed[i].lease }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );
  await ok(
    "resume resolver rejection retains paused state",
    "resume",
    { resolution: { eligible: false, code: "provider-route-unavailable" } },
    (v, trace) => {
      assert.equal(v, null);
      assert.equal(trace.length, 1);
    },
  );
  state = await snapshot("paused route rejection is durable");
  for (const s of state)
    assert.equal(s.cycles[0].eligibility_code, "provider-route-unavailable");
  await seed(
    "UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at='2026-10-25T00:00:00.123Z' WHERE id='github'",
  );
  before = await snapshot("before project-paused resume");
  await ok(
    "project pause avoids resolver and writes",
    "resume",
    {},
    (v, trace) => {
      assert.equal(v, null);
      assert.deepEqual(trace, []);
    },
  );
  assert.deepEqual(
    await snapshot("project pause retains paused cycle"),
    before,
  );
  await seed([
    "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
    `UPDATE task_workers SET enabled=false WHERE id='${worker}'`,
  ]);
  resumed = await ok(
    "retained paused execution may resume with disabled worker just as Source",
    "resume",
    {},
    (v) => {
      assert.equal(v.cycle.fencingToken, 4);
      assert.equal(v.taskWorker.enabled, false);
      assert.equal(v.cycle.codexThreadId, "retained");
    },
  );

  await clean();
  for (const action of ["claim", "resume"]) {
    await ok(
      "missing owner ignores unused invalid clock for " + action,
      action,
      { owner: "missing-owner", options: { now: "invalid-time" } },
      (v) => assert.equal(v, null),
    );
    await ok(
      "no candidates ignore unused invalid clock for " + action,
      action,
      { options: { now: "invalid-time" } },
      (v) => assert.equal(v, null),
    );
    await ok(
      "unused out-of-range expiry is not a new startup gate for " + action,
      action,
      { options: { now: stamp, leaseMs: Number.MAX_SAFE_INTEGER } },
      (v) => assert.equal(v, null),
    );
    for (const leaseMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await run(
        "invalid duration " + action + " " + leaseMs,
        action,
        { options: { now: stamp, leaseMs } },
        { error: true },
      );
  }
  await run(
    "claim rejects empty lease owner",
    "claim",
    { leaseOwner: " \ufeff " },
    { error: true },
  );
  for (const operation of [
    "🦀".repeat(100),
    "raw-\ud800-\udfff",
    " \ufeff preserved operation \ufeff ",
  ]) {
    await clean();
    await enqueue("task", operation);
    await claim("UTF16 operation ID survives actual storage");
  }

  await clean();
  await enqueue();
  claimed = await claim();
  await seed(
    `UPDATE task_dispatch_cycles SET lease_expires_at=${literal(stamp)}::timestamptz-interval '1 millisecond'`,
  );
  await ok("unstarted expired claim is requeued", "requeue", {}, (v) => {
    assert.equal(v.length, 1);
    assert.equal(v[0].state, "queued");
    assert.equal(v[0].fencingToken, 2);
    assert.equal(v[0].selectedTaskWorkerId, null);
    assert.equal(v[0].attemptCount, 1);
    assert.equal(v[0].eligibilityCode, "reconciliation-required");
  });
  await ok("already requeued claim is not repeated", "requeue", {}, (v) =>
    assert.deepEqual(v, []),
  );
  claimed = await claim();
  await ok("mark actual started lease", "running", (i) => ({
    fence: claimed[i].lease,
    options: { now: stamp, turnId: "started-turn" },
  }));
  await seed(
    `UPDATE task_dispatch_cycles SET lease_expires_at=${literal(stamp)}::timestamptz-interval '1 millisecond'`,
  );
  await ok(
    "started running lease is never blindly requeued",
    "requeue",
    {},
    (v) => assert.deepEqual(v, []),
  );
  await ok(
    "started running lease expires and preserves affinity",
    "expire",
    {},
    (v) => {
      assert.equal(v.length, 1);
      assert.equal(v[0].state, "expired");
      assert.equal(v[0].fencingToken, 4);
      assert.equal(v[0].selectedTaskWorkerId, worker);
      assert.equal(v[0].turnId, "started-turn");
      assert.equal(v[0].leaseOwner, null);
      assert.equal(v[0].worktreeId, "github-alpha-main");
    },
  );
  await ok("already expired running lease is not repeated", "expire", {}, (v) =>
    assert.deepEqual(v, []),
  );
  await clean();
  await enqueue();
  claimed = await claim();
  await seed(
    `UPDATE task_dispatch_cycles SET started_at=${literal(stamp)},lease_expires_at=${literal(stamp)}`,
  );
  await ok(
    "started claimed lease expires at the exact deadline",
    "expire",
    {},
    (v) => {
      assert.equal(v.length, 1);
      assert.equal(v[0].state, "expired");
    },
  );

  async function goal() {
    await clean([
      "UPDATE tasks SET plan_goal_enabled=true,state='review',has_plan=true WHERE chat_id='task'",
    ]);
    await enqueue("task", "finalize-operation", "finalize");
    const values = await claim();
    await ok("start retained Goal dispatch", "running", (i) => ({
      fence: values[i].lease,
      options: {
        now: stamp,
        affinity: {
          worktreeId: "github-alpha-main",
          threadId: "retained-thread",
          modelRouteId: "scheduler-route",
          providerAccountId: null,
        },
      },
    }));
    await seed(
      `UPDATE tasks SET state='implementing',has_final_plan=true,has_goal_prompt=true,implementation_started_at=${literal(stamp)} WHERE chat_id='task'`,
    );
    return ok("read retained Goal cycle", "get", (i) => ({
      cycle: values[i].cycle.id,
    }));
  }
  let expected = await goal();
  await ok(
    "live Goal lease retains existing owner and fence",
    "recover",
    (i) => ({ expected: expected[i], leaseOwner: "other-server" }),
    (v) => {
      assert.equal(v.leaseOwner, "scheduler-owner");
      assert.equal(v.fencingToken, 1);
    },
  );
  await reopen("retained Goal affinity survives process reopen");
  await seed(
    `UPDATE task_dispatch_cycles SET lease_expires_at=${literal(stamp)}::timestamptz-interval '1 millisecond'`,
  );
  let recovered = await ok(
    "expired retained Goal lease is re-fenced without replay",
    "recover",
    (i) => ({ expected: expected[i], leaseOwner: "recovery-server" }),
    (v) => {
      assert.equal(v.leaseOwner, "recovery-server");
      assert.equal(v.fencingToken, 2);
    },
  );
  await conflict(
    "old Goal recovery fence is stale",
    "recover",
    (i) => ({ expected: expected[i] }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );
  state = await snapshot(
    "Goal recovery retained session and only advanced lease",
  );
  for (const s of state) {
    assert.equal(s.cycles[0].codex_thread_id, "retained-thread");
    assert.equal(s.cycles[0].attempt_count, 1);
    assert.equal(s.tasks.find((t) => t.chat_id === "task").row_version, 1);
  }
  for (const [column, value] of [
    ["state", "'complete'"],
    ["plan_goal_enabled", "false"],
    ["has_final_plan", "false"],
    ["has_goal_prompt", "false"],
    ["implementation_started_at", "NULL"],
  ]) {
    expected = await goal();
    await seed(`UPDATE tasks SET ${column}=${value} WHERE chat_id='task'`);
    await conflict(
      "Goal recovery requires retained Task metadata " + column,
      "recover",
      (i) => ({ expected: expected[i] }),
      "stale-lease",
      "The Task dispatch lease is stale or no longer active.",
    );
  }
  for (const key of [
    "operationId",
    "fencingToken",
    "codexThreadId",
    "worktreeId",
  ]) {
    expected = await goal();
    await conflict(
      "Goal recovery fences changed " + key,
      "recover",
      (i) => ({
        expected: {
          ...expected[i],
          [key]: key === "fencingToken" ? 99 : "changed",
        },
      }),
      "stale-lease",
      "The Task dispatch lease is stale or no longer active.",
    );
  }
  expected = await goal();
  await seed(
    "UPDATE task_dispatch_cycles SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL",
  );
  await conflict(
    "settled Goal needs explicit recovery permission",
    "recover",
    (i) => ({ expected: expected[i] }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );
  await ok(
    "explicit settled Goal recovery reacquires real capacity",
    "recover",
    (i) => ({
      expected: expected[i],
      options: { now: stamp, allowSettled: true },
      leaseOwner: "new-server",
    }),
    (v) => {
      assert.equal(v.fencingToken, 2);
      assert.equal(v.leaseOwner, "new-server");
    },
  );
  for (const assignment of ["enabled=false", "allows_plan_goal=false"]) {
    expected = await goal();
    await seed([
      "UPDATE task_dispatch_cycles SET state='failed'",
      `UPDATE task_workers SET ${assignment} WHERE id='${worker}'`,
    ]);
    await conflict(
      "settled Goal reacquisition checks worker " + assignment,
      "recover",
      (i) => ({
        expected: expected[i],
        options: { now: stamp, allowSettled: true },
      }),
      "active-operation",
      "The selected Task Worker is disabled or no longer allows Plan + Goal. Enable it before resuming.",
    );
  }
  expected = await goal();
  await seed([
    "UPDATE task_dispatch_cycles SET state='failed'",
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,selected_task_worker_id,created_at,updated_at) VALUES('${id(140)}',${literal(owner)},'scheduler-next','capacity-blocker','direct','claimed',${literal(stamp)},'${worker}',${literal(stamp)},${literal(stamp)})`,
  ]);
  await conflict(
    "settled Goal recovery cannot exceed Task worker capacity",
    "recover",
    (i) => ({
      expected: expected[i],
      options: { now: stamp, allowSettled: true },
    }),
    "active-operation",
    "The Task Worker has no available capacity. Retry when a running Task finishes.",
  );
  await ok(
    "technical failed-lease recovery retains original Source capacity semantics",
    "recover",
    (i) => ({ expected: expected[i] }),
    (v) => assert.equal(v.fencingToken, 2),
  );
  expected = await goal();
  await seed(
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,created_at,updated_at) SELECT '${id(141)}',owner_id,chat_id,'newer-operation','finalize','succeeded',fifo_created_at,created_at+interval '1 millisecond',updated_at FROM task_dispatch_cycles WHERE operation_id='finalize-operation'`,
  );
  await conflict(
    "newer durable cycle prevents historical Goal recovery",
    "recover",
    (i) => ({ expected: expected[i] }),
    "stale-lease",
    "The Task dispatch lease is stale or no longer active.",
  );

  await clean();
  await enqueue();
  before = await snapshot("before post-claim Task write failure");
  await seed([
    "CREATE FUNCTION scheduler_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled Task claim rollback'; END $$",
    "CREATE TRIGGER scheduler_fixture_fail BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION scheduler_fixture_fail()",
  ]);
  await run(
    "Task metadata failure rolls back claimed cycle and fence",
    "claim",
    {},
    { error: true, sqlstate: "P0001" },
  );
  await seed([
    "DROP TRIGGER scheduler_fixture_fail ON tasks",
    "DROP FUNCTION scheduler_fixture_fail()",
  ]);
  assert.deepEqual(
    await snapshot("post-claim failure leaves queue and Task unchanged"),
    before,
  );
  await claim("same operation remains claimable after real rollback", {}, (v) =>
    assert.equal(v.cycle.fencingToken, 1),
  );
  await snapshot("final Task dispatch state");
  if (h.databaseMode === "postgres")
    await runTaskSchedulerRaces(h, {
      clean,
      enqueue,
      claim,
      ok,
      goal,
      worker,
      second,
      eligible,
    });
}
