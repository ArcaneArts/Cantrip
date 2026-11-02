// Exercise the actual Task repositories and inspect their persisted state.
import assert from "node:assert/strict";
import { runTaskRepositoryRaces } from "./task-repository-races.mjs";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
import {
  taskContent,
  taskEnvelope,
  taskOperationId,
  taskStart,
  taskResult,
} from "./task-wire-fixtures.mjs";
export async function runTaskRepositoryCases(h) {
  const { observe, seed, owner, reset, reopen } = h;
  const chat = "task";
  const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
  const run = (name, action, fields = {}, options = {}) =>
    observe(
      name,
      { chat, action, ...fields },
      { op: "native-command-task", shape: "raw", ...options },
    );
  async function ok(name, action, fields = {}, check = () => {}) {
    const values = await run(name, action, fields);
    for (const v of values) {
      assert.ok(Object.hasOwn(v, "value"), name + JSON.stringify(v));
      check(v.value);
    }
    return values.map((v) => v.value);
  }
  async function rejected(
    name,
    action,
    fields,
    code,
    message,
    stateTransition = null,
  ) {
    const before = await snapshot("before " + name);
    const values = await run(name, action, fields);
    for (const v of values)
      assert.deepEqual(v, { error: { code, stateTransition, message } }, name);
    assert.deepEqual(await snapshot("unchanged " + name), before, name);
  }
  const snapshot = (name) =>
    observe(
      name,
      {
        sql: "SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY chat_id) FROM tasks t),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id,ordinal) FROM task_planning_rounds r),'cycles',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM task_dispatch_cycles c),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY tab_key) FROM tab_group_members m)) result",
      },
      { op: "query-json", shape: "raw" },
    );
  async function versionRangeErrors(action, task) {
    for (const rowVersion of [2147483648, Number.MAX_SAFE_INTEGER]) {
      const name = `${action} preserves database integer range error at ${rowVersion}`;
      const before = await snapshot("before " + name);
      await run(
        name,
        action,
        { input: { rowVersion, task } },
        { error: true, sqlstate: "22003" },
      );
      assert.deepEqual(await snapshot("unchanged " + name), before);
    }
  }
  async function clean(plan = false, content = taskContent(), extra = []) {
    await reset();
    await seed([
      "DELETE FROM tasks",
      "UPDATE chats SET experience='task' WHERE id='task'",
      `INSERT INTO tasks(chat_id,state,plan_goal_enabled,stable_state_before_failure,active_operation_kind,plan_authorship,planning_round,has_plan,has_questions,has_final_plan,has_goal_prompt,last_error,protected_content,created_at,updated_at) VALUES('task',${literal(content.classification.state)},${plan},${literal(content.classification.stableStateBeforeFailure)},${literal(content.classification.activeOperationKind)},${literal(content.classification.planAuthorship)},${content.classification.planningRound},${content.classification.hasPlan},${content.classification.hasQuestions},${content.classification.hasFinalPlan},${content.classification.hasGoalPrompt},${content.classification.lastError ? json(content.classification.lastError) : "NULL"},${json(content.protectedContent)},${literal(stamp)},${literal(stamp)})`,
      ...extra,
    ]);
  }
  const start = (
    kind = "initial-plan",
    ordinal = 1,
    rowVersion = 1,
    operation = id(81),
  ) => taskStart(kind, chat, ordinal, rowVersion, operation);
  const startOperation = (
    input,
    name = "start encrypted " + input.operation.classification.kind,
  ) =>
    ok(name, "begin", { input }, (v) => {
      assert.equal(v.idempotent, false);
      assert.equal(v.round.status, "running");
      assert.equal(v.task.activeOperationId, input.operation.operationId);
      assert.equal(v.task.rowVersion, input.rowVersion + 1);
    });
  const complete = (
    input,
    name = "complete encrypted " + input.operation.classification.kind,
  ) =>
    ok(name, "complete", {
      operation: input.operation.operationId,
      input: taskResult(input),
      turn: "task-turn",
    });
  await clean();
  await ok("missing Task returns null", "get", { chat: "missing" }, (v) =>
    assert.equal(v, null),
  );
  await ok(
    "foreign project principal cannot read Task",
    "get",
    { owner: otherOwner },
    (v) => assert.equal(v, null),
  );
  await ok(
    "foreign principal has no planning rounds",
    "rounds",
    { owner: otherOwner },
    (v) => assert.deepEqual(v, []),
  );
  await ok("initial opaque Task summary", "get", {}, (v) => {
    assert.equal(v.rowVersion, 1);
    assert.equal(v.automaticRetry, null);
    assert.deepEqual(v.protectedContent, taskEnvelope);
  });
  await ok("project Task list", "list", { project: "github" }, (v) =>
    assert.deepEqual(
      v.map((t) => t.chatId),
      [chat],
    ),
  );
  await seed(`UPDATE chats SET archived_at=${literal(stamp)} WHERE id='task'`);
  await ok(
    "archived Task excluded from list",
    "list",
    { project: "github" },
    (v) => assert.deepEqual(v, []),
  );
  await ok("get preserves existing archived Task behavior", "get", {}, (v) =>
    assert.equal(v.chatId, chat),
  );
  await ok("archived Task cannot be deleted", "delete", {}, (v) =>
    assert.equal(v, null),
  );
  await clean();
  let edit = taskContent("draft", 0, {
    planAuthorship: "user-edited",
    hasPlan: true,
  });
  await ok(
    "draft saves supplied fields and increments scheduler and row versions",
    "draft",
    {
      input: {
        rowVersion: 1,
        task: edit,
        priority: 17,
        planGoalEnabled: true,
        draftAttachmentIds: ["attachment"],
        requestedTaskWorkerId: null,
      },
    },
    (v) => {
      assert.equal(v.rowVersion, 2);
      assert.equal(v.schedulerRevision, 2);
      assert.equal(v.priority, 17);
      assert.equal(v.planGoalEnabled, true);
      assert.deepEqual(v.draftAttachmentIds, ["attachment"]);
    },
  );
  await rejected(
    "stale draft edit",
    "draft",
    { input: { rowVersion: 1, task: edit } },
    "stale-version",
    "The Task draft changed in another client.",
  );
  await versionRangeErrors("draft", edit);
  await rejected(
    "draft cannot mutate operational metadata",
    "draft",
    { input: { rowVersion: 2, task: taskContent("review") } },
    "stale-version",
    "The encrypted Task mutation changed server-owned state.",
  );
  await rejected(
    "unavailable requested Task worker",
    "draft",
    { input: { rowVersion: 2, task: edit, requestedTaskWorkerId: id(991) } },
    "stale-version",
    "The selected Task Worker is unavailable.",
  );
  await ok(
    "missing owner draft edit is null",
    "draft",
    { owner: "missing-owner", input: { rowVersion: 1, task: taskContent() } },
    (v) => assert.equal(v, null),
  );
  const cycle = `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,queued_at,created_at,updated_at) VALUES('${id(90)}',${literal(owner)},'task','queued-operation','direct','queued',${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`;
  await seed(cycle);
  await ok(
    "queued cycle edit changes operation kind and fences prior claims",
    "draft",
    { input: { rowVersion: 2, task: edit, planGoalEnabled: false } },
    (v) => {
      assert.equal(v.rowVersion, 3);
      assert.equal(v.schedulerRevision, 3);
      assert.equal(v.dispatch.operationKind, "direct");
      assert.equal(v.dispatch.fencingToken, 1);
    },
  );
  await seed("UPDATE task_dispatch_cycles SET state='claimed'");
  await rejected(
    "claimed draft can no longer be edited",
    "draft",
    { input: { rowVersion: 3, task: edit } },
    "operation-active",
    "The Task has already started and can no longer be edited.",
  );
  await rejected(
    "active cycle wins before plan state validation",
    "plan",
    { input: { rowVersion: 3, task: edit } },
    "operation-active",
    "The next Task cycle is already queued or running.",
  );

  await clean();
  const direct = start("direct");
  const wrongChat = structuredClone(direct);
  wrongChat.operation.chatId = "other-task";
  await rejected(
    "encrypted operation cannot target another chat",
    "begin",
    { input: wrongChat },
    "idempotency-conflict",
    "The encrypted Task operation belongs to another Task.",
  );
  await rejected(
    "disabled Plan Goal rejects planning",
    "begin",
    { input: start() },
    "idempotency-conflict",
    "Enable Plan + Goal before starting a planning operation.",
  );
  await rejected(
    "stale operation version",
    "begin",
    { input: start("direct", 1, 2) },
    "stale-version",
    "The Task changed in another client.",
  );
  await rejected(
    "stale operation ordinal",
    "begin",
    { input: start("direct", 2) },
    "stale-version",
    "The encrypted Task planning round is stale.",
  );
  await startOperation(direct);
  let state = await snapshot(
    "direct implementation starts with its active round",
  );
  assert.ok(state.every((v) => v.tasks[0].implementation_started_at !== null));
  await rejected(
    "active operation fences second operation",
    "begin",
    { input: start("direct", 2, 2, id(83)) },
    "operation-active",
    "This Task already has an active operation.",
  );
  const beforeReplay = await snapshot("before duplicate start");
  const replay = structuredClone(direct);
  replay.rowVersion = 999;
  replay.operation.protectedInput.envelope.nonce = "BBBBBBBBBBBBBBBB";
  await ok(
    "same identity replays stored request despite nonce and stale row version",
    "begin",
    { input: replay },
    (v) => {
      assert.equal(v.idempotent, true);
      assert.equal(
        v.relayRequest.protectedInput.envelope.nonce,
        direct.operation.protectedInput.envelope.nonce,
      );
    },
  );
  assert.deepEqual(
    await snapshot("duplicate start does not write"),
    beforeReplay,
  );
  const conflict = structuredClone(direct);
  conflict.operation.fingerprint = Buffer.alloc(32, 1).toString("base64url");
  await rejected(
    "same operation ID rejects different fingerprint",
    "begin",
    { input: conflict },
    "idempotency-conflict",
    "This Task operation ID was already used for different input.",
  );
  await ok(
    "attach explicit null lane and input",
    "attach",
    {
      operation: direct.operation.operationId,
      input: { executionLaneId: null, userMessageId: null },
    },
    (v) => assert.equal(v.round.executionLaneId, null),
  );
  await ok(
    "missing round attachment returns null",
    "attach",
    {
      operation: "missing",
      input: { executionLaneId: null, userMessageId: null },
    },
    (v) => assert.equal(v, null),
  );
  await complete(direct);
  await ok(
    "direct completion clears operation and records completion time",
    "get",
    {},
    (v) => {
      assert.equal(v.state, "complete");
      assert.equal(v.activeOperationId, null);
      assert.ok(v.completedAt);
    },
  );
  const beforeResultReplay = await snapshot("before duplicate result");
  const resultReplay = taskResult(direct);
  resultReplay.protectedResult.envelope.nonce = "BBBBBBBBBBBBBBBB";
  await ok(
    "same result fingerprint retains first ciphertext and turn",
    "complete",
    {
      operation: direct.operation.operationId,
      input: resultReplay,
      turn: "different-turn",
    },
    (v) => {
      assert.equal(v.round.turnId, "task-turn");
      assert.equal(
        v.relayResult.protectedResult.envelope.nonce,
        taskEnvelope.envelope.nonce,
      );
    },
  );
  assert.deepEqual(
    await snapshot("duplicate result does not write"),
    beforeResultReplay,
  );
  const wrongResult = taskResult(direct);
  wrongResult.fingerprint = Buffer.alloc(32, 1).toString("base64url");
  await rejected(
    "result fingerprint must match admitted operation",
    "complete",
    { operation: direct.operation.operationId, input: wrongResult },
    "idempotency-conflict",
    "The encrypted Task result does not match its operation.",
  );
  await rejected(
    "completed Task cannot start again",
    "begin",
    { input: start("direct", 2, 3, id(83)) },
    null,
    "A Task cannot transition from complete to implementing.",
    { from: "complete", to: "implementing" },
  );

  await clean(true);
  await rejected(
    "enabled Plan Goal rejects direct execution",
    "begin",
    { input: direct },
    "idempotency-conflict",
    "Disable Plan + Goal before starting this Task directly.",
  );
  const initial = start();
  await startOperation(initial);
  await complete(initial);
  edit = taskContent("review", 1, { hasPlan: true, planAuthorship: "mixed" });
  await ok(
    "review plan edit preserves scheduler revision",
    "plan",
    { input: { rowVersion: 3, task: edit } },
    (v) => {
      assert.equal(v.rowVersion, 4);
      assert.equal(v.schedulerRevision, 1);
      assert.equal(v.planAuthorship, "mixed");
    },
  );
  await rejected(
    "stale review plan edit",
    "plan",
    { input: { rowVersion: 3, task: edit } },
    "stale-version",
    "The Task plan changed in another client.",
  );
  await versionRangeErrors("plan", edit);
  const continued = start("continue-plan", 2, 4, id(83));
  await startOperation(continued);
  await complete(continued);
  await seed([
    `INSERT INTO chat_execution_lanes(id,chat_id,worker_id,worktree_id,acquiring_actor,state,created_at,updated_at) VALUES('${id(95)}','task','alpha','github-alpha-main','task-fixture','released',${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO chat_messages(id,chat_id,worktree_id,role,mode,task_protected_content,created_at) VALUES('${id(96)}','task','github-alpha-main','user','plan',${json(taskEnvelope)},${literal(stamp)}),('${id(97)}','task','github-alpha-main','assistant','plan',${json(taskEnvelope)},${literal(stamp)})`,
  ]);
  for (const operation of [id(81), id(83)]) {
    await ok(
      "attach real Task execution references " + operation,
      "attach",
      {
        operation,
        input: { executionLaneId: id(95), userMessageId: id(96) },
      },
      (v) => {
        assert.equal(v.round.executionLaneId, id(95));
        assert.equal(v.round.userMessageId, id(96));
      },
    );
  }
  await ok(
    "attach real assistant message",
    "assistant",
    { operation: id(83), message: id(97) },
    (v) => assert.equal(v.round.assistantMessageId, id(97)),
  );
  await ok(
    "input lookup selects first matching planning round",
    "lookup",
    { lookup: { userMessageId: id(96) } },
    (v) => assert.equal(v.round.id, id(81)),
  );
  await ok(
    "execution lane lookup selects last matching planning round",
    "lookup",
    { lookup: { executionLaneId: id(95) } },
    (v) => assert.equal(v.round.id, id(83)),
  );
  await ok(
    "input filter wins over lane filter and still chooses final row",
    "lookup",
    { lookup: { userMessageId: id(96), executionLaneId: "missing-lane" } },
    (v) => assert.equal(v.round.id, id(83)),
  );
  await ok(
    "missing input filter does not fall back to a matching lane",
    "lookup",
    { lookup: { userMessageId: "missing-input", executionLaneId: id(95) } },
    (v) => assert.equal(v, null),
  );
  await ok(
    "foreign principal cannot attach assistant",
    "assistant",
    { owner: otherOwner, operation: id(83), message: id(97) },
    (v) => assert.equal(v, null),
  );
  const finalized = start("finalize", 3, 6, id(84));
  await startOperation(finalized);
  await complete(finalized);
  await ok(
    "finalized encrypted result waits for Goal startup acknowledgment",
    "get",
    {},
    (v) => {
      assert.equal(v.state, "finalizing");
      assert.equal(v.activeOperationId, id(84));
      assert.equal(v.rowVersion, 7);
      assert.equal(v.implementationStartedAt, null);
    },
  );
  await ok(
    "round lookup prioritizes operation ID",
    "lookup",
    {
      lookup: {
        operationId: id(81),
        userMessageId: "missing",
        executionLaneId: "missing",
      },
    },
    (v) => assert.equal(v.round.id, id(81)),
  );
  await ok(
    "empty operation lookup retains first-round source behavior",
    "lookup",
    { lookup: {} },
    (v) => assert.equal(v.round.id, id(81)),
  );
  await ok("planning rounds retain ordinal order", "rounds", {}, (v) =>
    assert.deepEqual(
      v.map((r) => r.ordinal),
      [1, 2, 3],
    ),
  );
  await reopen(
    "Task finalization and opaque relay result survive process reopen",
  );
  await ok(
    "resume finalization reads stored encrypted result after reopen",
    "resume",
    {},
    (v) => {
      assert.equal(v.round.id, id(84));
      assert.equal(v.relayResult.goal.classification.status, "active");
    },
  );
  const badFailure = structuredClone(taskResult(finalized).goal.failureTask);
  badFailure.classification.hasPlan = false;
  await rejected(
    "Goal startup failure must preserve finalized metadata",
    "fail",
    { operation: id(84), failure: badFailure },
    "idempotency-conflict",
    "The encrypted Goal startup failure does not match finalization.",
  );
  await ok(
    "Goal startup failure uses encrypted worker failure content",
    "fail",
    { operation: id(84), failure: taskResult(finalized).goal.failureTask },
    (v) => {
      assert.equal(v.task.state, "failed");
      assert.equal(v.task.hasFinalPlan, true);
      assert.equal(v.task.rowVersion, 8);
    },
  );
  await ok(
    "acknowledgment may recover failed Goal startup for same round",
    "finalize",
    { operation: id(84) },
    (v) => {
      assert.equal(v.task.state, "implementing");
      assert.equal(v.task.rowVersion, 9);
      assert.ok(v.task.implementationStartedAt);
    },
  );
  let before = await snapshot("before repeated Goal startup acknowledgment");
  await ok(
    "repeated Goal startup acknowledgment is idempotent",
    "finalize",
    { operation: id(84) },
    (v) => assert.equal(v.task.rowVersion, 9),
  );
  assert.deepEqual(
    await snapshot("Goal acknowledgment replay does not write"),
    before,
  );
  let goalTask = taskResult(finalized).task;
  await ok(
    "Goal synchronization retains source raw JSONB serialization behavior",
    "sync",
    { input: { rowVersion: 9, task: goalTask } },
    (v) => assert.equal(v.rowVersion, 10),
  );
  before = await snapshot(
    "raw JSONB comparison advances the same revision as Source",
  );
  const metadata = structuredClone(goalTask);
  metadata.classification.hasPlan = false;
  await rejected(
    "Goal synchronization cannot change planning metadata",
    "sync",
    { input: { rowVersion: 10, task: metadata } },
    "idempotency-conflict",
    "The encrypted Goal update changes protected planning metadata.",
  );
  await rejected(
    "Goal synchronization checks row revision",
    "sync",
    { input: { rowVersion: 1, task: goalTask } },
    "stale-version",
    "The Task changed before its Goal status was synchronized.",
  );
  let version = 10;
  for (const state of [
    "paused",
    "blocked",
    "implementing",
    "failed",
    "complete",
  ]) {
    goalTask = structuredClone(goalTask);
    goalTask.classification.state = state;
    await ok(
      "Goal state transition " + state,
      "sync",
      { input: { rowVersion: version, task: goalTask } },
      (v) => {
        assert.equal(v.state, state);
        assert.equal(v.rowVersion, version + 1);
        assert.equal(Boolean(v.completedAt), state === "complete");
      },
    );
    version++;
  }
  before = await snapshot("before identical completed Goal sync");
  await ok(
    "completed Goal retains timestamp on identical sync",
    "sync",
    { input: { rowVersion: version, task: goalTask } },
    (v) => assert.equal(v.rowVersion, version + 1),
  );
  const afterCompleted = await snapshot(
    "completed Goal repeated sync retains its completion timestamp",
  );
  for (let i = 0; i < before.length; i++) {
    assert.equal(
      afterCompleted[i].tasks[0].completed_at,
      before[i].tasks[0].completed_at,
    );
    assert.equal(
      afterCompleted[i].tasks[0].row_version,
      before[i].tasks[0].row_version + 1,
    );
  }
  version++;
  const backwards = structuredClone(goalTask);
  backwards.classification.state = "implementing";
  await rejected(
    "completed Goal cannot return to implementing",
    "sync",
    { input: { rowVersion: version, task: backwards } },
    null,
    "A Task cannot transition from complete to implementing.",
    { from: "complete", to: "implementing" },
  );

  await clean(true);
  await startOperation(initial);
  await ok(
    "operation failure persists pre-encrypted failure metadata",
    "fail",
    { operation: id(81) },
    (v) => {
      assert.equal(v.task.state, "failed");
      assert.equal(v.task.activeOperationId, null);
      assert.equal(v.round.status, "failed");
      assert.equal(v.task.rowVersion, 3);
    },
  );
  before = await snapshot("before repeated failure");
  await ok(
    "operation failure replay is idempotent",
    "fail",
    { operation: id(81) },
    (v) => assert.equal(v.task.rowVersion, 3),
  );
  assert.deepEqual(await snapshot("repeated failure does not write"), before);
  const retry = start("initial-plan", 2, 3, id(83));
  await startOperation(
    retry,
    "failed draft may start a new encrypted planning round",
  );
  await ok(
    "older round failure cannot replace newer active Task",
    "fail",
    { operation: id(81) },
    (v) => {
      assert.equal(v.task.state, "planning");
      assert.equal(v.task.activeOperationId, id(83));
      assert.equal(v.task.rowVersion, 4);
    },
  );
  await rejected(
    "late result cannot supersede a newer operation",
    "complete",
    { operation: id(81), input: taskResult(initial) },
    "idempotency-conflict",
    "A newer Task operation superseded this result.",
  );
  await ok(
    "foreign principal cannot fail an operation",
    "fail",
    { owner: otherOwner, operation: id(83) },
    (v) => assert.equal(v, null),
  );
  await reopen("active encrypted Task operation survives process reopen");
  await ok(
    "restart reconciles active Task to its stored failure",
    "reconcile",
    {},
    (v) => assert.equal(v, 1),
  );
  await ok("restart reconciliation runs only once", "reconcile", {}, (v) =>
    assert.equal(v, 0),
  );
  await ok(
    "reconciled Task retains opaque failure and incremented revision",
    "get",
    {},
    (v) => {
      assert.equal(v.state, "failed");
      assert.equal(v.rowVersion, 5);
      assert.equal(v.planningRound, 2);
    },
  );
  await ok(
    "missing active operation resume retains first-round fallback",
    "resume",
    {},
    (v) => assert.equal(v.round.id, id(81)),
  );

  await clean(true);
  before = await snapshot("before transaction rollback at post-round CAS");
  await seed([
    "CREATE FUNCTION task_fixture_conflict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE tasks SET row_version=row_version+1 WHERE chat_id=NEW.chat_id; RETURN NEW; END $$",
    "CREATE TRIGGER task_fixture_conflict AFTER INSERT ON task_planning_rounds FOR EACH ROW EXECUTE FUNCTION task_fixture_conflict()",
  ]);
  await rejected(
    "post-round Task version conflict rolls back entire transaction",
    "begin",
    { input: initial },
    "stale-version",
    "The Task changed in another client.",
  );
  await seed([
    "DROP TRIGGER task_fixture_conflict ON task_planning_rounds",
    "DROP FUNCTION task_fixture_conflict()",
  ]);
  assert.deepEqual(
    await snapshot("rollback retains Task and removes attempted round"),
    before,
  );
  await startOperation(initial, "normal operation works after real rollback");
  await snapshot("actual Task state after rollback and successful retry");

  if (h.databaseMode === "postgres") await runTaskRepositoryRaces(h, clean);
  await clean();
  await seed(
    `UPDATE tasks SET automatic_retry=${json({ status: "scheduled", failureKind: "connection", failureKey: "failure", dueAt: Date.parse(stamp), attempts: [0], claim: null })}`,
  );
  await ok("Task retry summary maps persisted schedule", "get", {}, (v) =>
    assert.deepEqual(v.automaticRetry, {
      status: "scheduled",
      failureKind: "connection",
      nextAttemptAt: stamp,
      recentAttempts: 0,
    }),
  );
  await seed("UPDATE tasks SET automatic_retry=NULL");
  await seed(cycle);
  await seed(
    `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,queued_at,created_at,updated_at) VALUES('${id(91)}',${literal(owner)},'task','settled-operation','initial-plan','succeeded',${literal(stamp)},${literal(stamp)},${literal(stamp)},${literal(stamp)})`,
  );
  await ok(
    "latest cycle tie uses descending cycle ID including settled state",
    "get",
    {},
    (v) => assert.equal(v.dispatch.id, id(91)),
  );
  await ok(
    "list uses same latest cycle selection",
    "list",
    { project: "github" },
    (v) => assert.equal(v[0].dispatch.id, id(91)),
  );
  await ok(
    "foreign Task delete is null",
    "delete",
    { owner: otherOwner },
    (v) => assert.equal(v, null),
  );
  await seed("UPDATE chats SET experience='agent' WHERE id='task'");
  await ok(
    "delete retains source agent-experience behavior",
    "delete",
    {},
    (v) => assert.deepEqual(v, { projectId: "github" }),
  );
  await ok("agent experience remains stored", "get", {}, (v) =>
    assert.equal(v.chatId, chat),
  );
  await seed("UPDATE chats SET experience='task' WHERE id='task'");
  await ok(
    "Task deletion returns project and cascades persisted Task state",
    "delete",
    {},
    (v) => assert.deepEqual(v, { projectId: "github" }),
  );
  await ok("deleted Task is absent", "get", {}, (v) => assert.equal(v, null));
  await snapshot("Task delete cascades rounds and cycles");
}
