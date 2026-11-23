// Direct model scheduling on real migrated stores, including retained lease fences.
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
  const configuration = {
    modelId: "scheduler-model",
    reasoningEffort: "high",
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
  };
  const chats = [
    "task",
    "scheduler-next",
    ...Array.from({ length: 8 }, (_, i) => `scheduler-${i + 2}`),
  ];
  const eligible = {
    eligible: true,
    modelRouteId: "scheduler-route",
    providerAccountId: null,
    codexThreadId: "retained-thread",
  };
  for (let i = 0; i < 10; i++)
    h.registerFixedClock(Date.parse(stamp) + i * 1000);
  const run = (name, action, fields = {}) =>
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
      { op: "native-command-task-scheduler", shape: "raw" },
    );
  async function ok(name, action, fields = {}, check = () => {}) {
    const values = await run(name, action, fields);
    for (const value of values) {
      assert.ok(Object.hasOwn(value, "value"), name + JSON.stringify(value));
      check(value.value, value.trace);
    }
    return values.map((value) => value.value);
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY fifo_created_at,chat_id,operation_id,id) FROM task_dispatch_cycles c),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  async function clean(statements = []) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "DELETE FROM task_workers",
      "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL",
      "UPDATE workers SET unlinked_at=NULL",
      `INSERT INTO model_profiles(id,owner_id,name) VALUES('scheduler-model',${literal(owner)},'Selected model') ON CONFLICT DO NOTHING`,
      `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('scheduler-provider',${literal(owner)},'Provider','openai-compatible','http://fixture.invalid') ON CONFLICT DO NOTHING`,
      "INSERT INTO model_routes(id,model_id,provider_id,model_name,enabled) VALUES('scheduler-route','scheduler-model','scheduler-provider','fixture',true) ON CONFLICT DO NOTHING",
      ...chats
        .slice(1)
        .map(
          (chat) =>
            `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,experience,protected_label,created_at,updated_at,last_used_at) VALUES(${literal(chat)},${literal(owner)},'github','alpha','github-alpha-main','task',${json(label("chat"))},${literal(stamp)},${literal(stamp)},${literal(stamp)}) ON CONFLICT(id) DO UPDATE SET archived_at=NULL,active_worker_id='alpha',active_worktree_id='github-alpha-main'`,
        ),
      ...chats.map(
        (chat, i) =>
          `INSERT INTO tasks(chat_id,protected_content,model_configuration,created_at,updated_at,priority) VALUES(${literal(chat)},${json(taskEnvelope)},${json(configuration)},${literal(stamp)}::timestamptz+interval '${i} seconds',${literal(stamp)},${i * 100})`,
      ),
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
      "enqueue " + chat,
      "enqueue",
      { chat, operation, kind, rowVersion },
      (cycle) => assert.equal(cycle.state, "queued"),
    );
  const claim = (name = "claim", fields = {}, check = () => {}) =>
    ok(name, "claim", fields, check);
  await clean();
  for (const [i, chat] of chats.entries()) {
    if (i % 2 === 0)
      await seed([
        `UPDATE tasks SET plan_goal_enabled=true WHERE chat_id=${literal(chat)}`,
      ]);
    await enqueue(
      chat,
      `operation-${i}`,
      i % 2 === 0 ? "initial-plan" : "direct",
    );
  }
  await ok(
    "foreign owner sees no tasks",
    "list",
    { owner: otherOwner },
    (value) => assert.deepEqual(value, []),
  );
  const claims = [];
  for (const chat of chats)
    claims.push(
      await claim(
        "claim all ten without presets or limits: " + chat,
        {},
        (value) => {
          assert.equal(value.cycle.chatId, chat);
          assert.equal(value.cycle.selectedTaskWorkerId, null);
          assert.deepEqual(value.modelConfiguration, configuration);
        },
      ),
    );
  await claim("all ten are active and queue is empty", {}, (value) =>
    assert.equal(value, null),
  );
  const active = await snapshot("ten active model-configured tasks");
  for (const state of active)
    assert.equal(
      state.cycles.filter((cycle) => cycle.state === "claimed").length,
      10,
    );
  await ok("mark one running", "running", (i) => ({
    fence: claims[0][i].lease,
  }));
  await ok("pause retains model and native session", "pause", (i) => ({
    fence: claims[0][i].lease,
    affinity: { threadId: "resident-thread", turnId: "resident-turn" },
  }));
  await ok("resume alongside nine active tasks", "resume", {}, (value) => {
    assert.equal(value.cycle.codexThreadId, "resident-thread");
    assert.deepEqual(value.modelConfiguration, configuration);
    assert.equal(value.cycle.state, "running");
  });
  const before = await snapshot("before reopen");
  await reopen("direct task model configurations survive process restart");
  assert.deepEqual(await snapshot("after reopen"), before);

  await clean();
  await enqueue();
  const queued = await snapshot("queued fence");
  const first = await claim();
  const paused = await ok(
    "pause unstarted launch advances fence",
    "pause-unstarted",
    (i) => ({
      fence: first[i].lease,
      affinity: { threadId: null, turnId: null },
    }),
  );
  const stale = await run(
    "old claimant cannot heartbeat",
    "heartbeat",
    (i) => ({ fence: first[i].lease }),
  );
  for (const result of stale) assert.equal(result.error.code, "stale-lease");
  await ok("unstarted claim resumes without preset", "resume", {}, (value) =>
    assert.equal(value.lease.fencingToken, paused[0].fencingToken),
  );

  await clean();
  await enqueue();
  await seed([
    `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(stamp)} WHERE id='github'`,
  ]);
  await claim("explicit project pause remains effective", {}, (value) =>
    assert.equal(value, null),
  );
  await seed([
    "UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id='github'",
  ]);
  await claim(
    "routing failure retains queue",
    { resolution: { eligible: false, code: "model-unavailable" } },
    (value) => assert.equal(value, null),
  );
  await claim("available model can claim after retry", {}, (value) =>
    assert.equal(value.cycle.chatId, "task"),
  );

  await clean();
  await enqueue();
  const delayed = await claim();
  const later = new Date(Date.parse(stamp) + 300000).toISOString();
  h.registerFixedClock(Date.parse(later));
  await ok(
    "expired unstarted claims can retry",
    "requeue",
    { options: { now: later } },
    (value) => assert.equal(value.length, 1),
  );
  const retried = await claim(
    "retry retains task configuration",
    { options: { now: later } },
    (value) => assert.deepEqual(value.modelConfiguration, configuration),
  );
  assert.ok(retried[0].lease.fencingToken > delayed[0].lease.fencingToken);
  await ok("started operation", "running", (i) => ({
    fence: retried[i].lease,
    options: { now: later },
  }));
  await ok("settle claimed model execution", "settle", (i) => ({
    fence: retried[i].lease,
    state: "succeeded",
    options: { now: later },
  }));

  if (h.databaseMode === "postgres")
    await runTaskSchedulerRaces(h, { clean, enqueue, claim, ok, eligible });
}
