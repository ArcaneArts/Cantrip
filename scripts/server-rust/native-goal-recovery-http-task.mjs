import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  settingsChat as agent,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  task,
  taskProject,
  taskTree,
} from "./native-event-http-setup.mjs";
import { literal, json, label, stamp } from "./project-target-state.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { taskContent } from "./task-wire-fixtures.mjs";
import {
  dashboardGoalWorker,
  goalMarker,
} from "./task-dashboard-goal-worker.mjs";
import {
  protectNativeSettingsSnapshot,
  openNativeSettingsSnapshot,
} from "../../cantrip_worker/src/native-settings-content.ts";
import {
  taskGoalHandoffCaptureSchema,
  taskGoalCycleRecoverySchema,
  taskGoalCycleRecoveryReceiptSchema,
} from "../../packages/protocol/dist/index.js";
import { recoveryQueueIdentity } from "../../cantrip_worker/src/inference-journal.ts";

export const goalRecoveryRouting = {
  provider: "goal-capture-provider",
  model: "goal-capture-model",
  route: "goal-capture-route",
};
const { provider, model, route } = goalRecoveryRouting;
const cycleId = "66666666-6666-4666-8666-666666666690";
const heartbeatChat = "55555555-5555-4555-8555-555555555556";
const heartbeatCycle = "66666666-6666-4666-8666-666666666693";
const heartbeatThread = "heartbeat-task-thread";
const runtime = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const replacementRuntime = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
const unavailableGeneration = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const marker = "private-native-goal-source";
const modelConfiguration = {
  modelId: model,
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: null,
  subagentReasoningEffort: null,
};

export function nativeGoalRecoverySeed(owner, scope) {
  scope.modelRouteId = route;
  return [
    ...seedEventChats(owner),
    `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider)},${literal(owner)},'Goal capture','openai-compatible','http://fixture.invalid')`,
    `INSERT INTO model_profiles(id,owner_id,name) VALUES(${literal(model)},${literal(owner)},'Goal capture model')`,
    `INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES(${literal(route)},${literal(model)},${literal(provider)},'goal-native',0)`,
    "UPDATE user_settings SET auto_name_chats=false,auto_name_tasks=false,default_model_id=NULL",
    `UPDATE projects SET task_scheduling_paused=true,task_scheduling_paused_at=${literal(stamp)} WHERE id=${literal(taskProject)}`,
    `UPDATE chats SET automation_paused=true,model_id=${literal(model)} WHERE id=${literal(task)}`,
    `UPDATE chats SET model_id=${literal(model)} WHERE id=${literal(agent)}`,
    `UPDATE chat_runtime_sessions SET model_route_id=${literal(route)} WHERE chat_id IN (${literal(task)},${literal(agent)})`,
  ];
}

export function taskGoalRecoveryHttpCases(h, result) {
  let capture,
    recovering,
    accepted,
    presence,
    sourceMode = "valid",
    held,
    release;
  let recoveryAttempts = 0;
  const controller = dashboardGoalWorker();
  Object.assign(result, {
    rawTaskCaptureReceipts: [],
    rawTaskRecoveryReceipts: [],
    rawTaskGoalObservations: [],
    rawTaskStages: [],
    taskCryptoProofs: 0,
  });
  const digest = (generation, identity) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          generation,
          identity.runtimeGeneration,
          identity.operationId,
        ]),
      )
      .digest("hex");
  const query = `SELECT jsonb_build_object('task',to_jsonb(t),'cycle',to_jsonb(c),'queue',to_jsonb(q),'binding',(SELECT to_jsonb(s) FROM native_settings_states s WHERE s.chat_id=t.chat_id),'messages',(SELECT count(*) FROM chat_messages WHERE chat_id=t.chat_id),'cycles',(SELECT count(*) FROM task_dispatch_cycles WHERE chat_id=t.chat_id)) result FROM tasks t JOIN task_dispatch_cycles c ON c.chat_id=t.chat_id JOIN managed_queue_states q ON q.chat_id=t.chat_id WHERE c.id=${literal(cycleId)}`;
  const heartbeatQuery = `SELECT jsonb_build_object('task',to_jsonb(t),'cycle',to_jsonb(c),'status',ch.status,'lanes',(SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM chat_execution_lanes l WHERE l.chat_id=t.chat_id),'messages',(SELECT count(*) FROM chat_messages WHERE chat_id=t.chat_id),'cycles',(SELECT count(*) FROM task_dispatch_cycles WHERE chat_id=t.chat_id)) result FROM tasks t JOIN chats ch ON ch.id=t.chat_id JOIN task_dispatch_cycles c ON c.chat_id=t.chat_id WHERE c.id=${literal(heartbeatCycle)}`;
  async function readQuery(sql) {
    return (
      await h.fixture.sql([], [sql.replace(" result", "::text result")])
    )[0];
  }
  function hold() {
    held = {
      requested: false,
      promise: new Promise((resolve) => (release = resolve)),
    };
    return held;
  }
  async function wait(read, predicate, label) {
    let value;
    const deadline = Date.now() + 20000;
    do {
      value = await read();
      if (predicate(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.ok(predicate(value), label);
  }
  async function handle(command, emit, scope) {
    if (command.type === "task.goal.source") {
      assert.ok(capture);
      assert.equal(command.cycleId, cycleId);
      assert.deepEqual(command.scope, {
        chatId: task,
        workerId: worker,
        threadId: "task-thread",
        contextKind: "project",
        projectId: taskProject,
        placementId: taskTree,
        modelRouteId: route,
        providerAccountId: null,
      });
      assert.equal(
        Object.hasOwn(command, "input"),
        false,
        "private-cycle capture does not fabricate a first input",
      );
      if (held) {
        held.requested = true;
        await held.promise;
      }
      const record = structuredClone(capture.record);
      if (sourceMode === "wrong-digest") record.key = "f".repeat(64);
      if (sourceMode === "old-generation") {
        record.workerGeneration = unavailableGeneration;
        record.key = digest(record.workerGeneration, record.identity);
      }
      const receipt = taskGoalHandoffCaptureSchema.parse({
        ...capture,
        record,
      });
      result.rawTaskCaptureReceipts.push({
        command: structuredClone(command),
        receipt,
        mode: sourceMode,
      });
      return receipt;
    }
    if (
      command.type === "chat.goal.get" &&
      [task, heartbeatChat].includes(command.chatId)
    ) {
      const phase = presence?.chatId === command.chatId ? presence : null;
      if (phase) {
        assert.equal(command.threadId, phase.threadId);
        assert.equal(command.taskContext.nativeCycle.cycleId, phase.cycleId);
        assert.equal(command.observeExecution, true);
        assert.equal(command.taskContext.message, null);
        assert.equal(command.model.routeId, route);
        assert.equal(command.provider.id, provider);
        assert.equal(
          phase.gate.requested,
          false,
          "one passive Goal observation",
        );
        phase.gate.requested = true;
        await phase.gate.promise;
      }
      const value = await controller.handle(command, emit, scope);
      assert.ok(value?.goal?.protectedObjective);
      await controller.proveObjective(h.owner, value.goal);
      result.taskCryptoProofs++;
      const receipt = {
        ...value,
        execution: {
          threadId: command.threadId,
          status: phase?.status ?? "idle",
        },
      };
      result.rawTaskGoalObservations.push({
        command: structuredClone(command),
        receipt,
        phase: phase?.name ?? "durable queue",
        workerGeneration: h.worker.connectionGeneration(),
      });
      return receipt;
    }
    if (command.type !== "task.goal.recover") return undefined;
    assert.ok(recovering);
    assert.deepEqual({ ...command.recovery, admission: null }, recovering);
    if (command.recovery.admission)
      assert.deepEqual(command.recovery.admission, {
        ...accepted.admission,
        workerGeneration: accepted.workerGeneration,
      });
    assert.equal(command.chatId, task);
    assert.equal(command.projectId, taskProject);
    assert.equal(command.worktreeId, taskTree);
    assert.equal(command.threadId, "task-thread");
    assert.equal(command.model.routeId, route);
    assert.equal(command.provider.id, provider);
    const attempt = ++recoveryAttempts;
    if (attempt === 2) {
      held.requested = true;
      await held.promise;
    }
    const receipt = taskGoalCycleRecoveryReceiptSchema.parse({
      status: "scheduled",
      sourceKey: recovering.sourceKey,
      workerGeneration:
        attempt === 1
          ? recovering.workerGeneration
          : h.worker.connectionGeneration(),
      admission: {
        operationId: "replacement-native-goal-cycle",
        runtimeGeneration: replacementRuntime,
      },
    });
    if (attempt > 1) accepted = receipt;
    result.rawTaskRecoveryReceipts.push({
      command: structuredClone(command),
      receipt,
    });
    return receipt;
  }
  async function runHeartbeat(content) {
    const heartbeatTask = await controller.protectTask(
      h.owner,
      heartbeatChat,
      content,
    );
    await h.fixture.sql([
      `INSERT INTO chats(id,owner_id,project_id,active_worktree_id,active_worker_id,protected_label,experience,status,model_id) VALUES(${literal(heartbeatChat)},${literal(h.owner)},${literal(taskProject)},${literal(taskTree)},${literal(worker)},${json(label("chat"))},'task','offline',${literal(model)})`,
      `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id) VALUES('heartbeat-task-runtime',${literal(heartbeatChat)},${literal(worker)},${literal(taskTree)},${literal(heartbeatThread)},${literal(route)})`,
      `INSERT INTO tasks(chat_id,state,planning_round,has_plan,has_final_plan,has_goal_prompt,plan_goal_enabled,protected_content,implementation_started_at,model_configuration) VALUES(${literal(heartbeatChat)},'implementing',1,true,true,true,true,${json(heartbeatTask.protectedContent)},${literal(stamp)},${json(modelConfiguration)})`,
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,model_route_id,physical_worker_id,worktree_id,codex_thread_id,fencing_token,started_at,model_configuration) VALUES(${literal(heartbeatCycle)},${literal(h.owner)},${literal(heartbeatChat)},'heartbeat-retained-operation','finalize','expired',${literal(stamp)},${literal(route)},${literal(worker)},${literal(taskTree)},${literal(heartbeatThread)},1,${literal(stamp)},${json(modelConfiguration)})`,
    ]);
    const heartbeatGate = hold();
    presence = {
      name: "HTTP heartbeat",
      chatId: heartbeatChat,
      cycleId: heartbeatCycle,
      threadId: heartbeatThread,
      status: "running",
      gate: heartbeatGate,
    };
    const beforeHeartbeat = await readQuery(heartbeatQuery);
    const heartbeatPath = "/api/internal/workers/heartbeat";
    const heartbeatRequest = {
      client: "worker",
      json: { ...heartbeat, workerId: worker },
    };
    try {
      await h.visit(
        "worker heartbeat requires credential",
        "POST",
        heartbeatPath,
        { ...heartbeatRequest, status: 401 },
      );
      assert.equal(heartbeatGate.requested, false);
      assert.deepEqual(await readQuery(heartbeatQuery), beforeHeartbeat);
      await h.visit(
        "worker heartbeat schedules passive Task adoption",
        "POST",
        heartbeatPath,
        {
          ...heartbeatRequest,
          headers: { authorization: "Bearer " + h.credential },
          status: 202,
        },
      );
      await wait(
        () => heartbeatGate.requested,
        Boolean,
        "authenticated heartbeat observes the saved Task session",
      );
      assert.deepEqual(await readQuery(heartbeatQuery), beforeHeartbeat);
      release();
      const adopted = await wait(
        () => readQuery(heartbeatQuery),
        (row) => row.lanes.some((lane) => lane.state === "active"),
        "observed running Task acquires an execution lane",
      );
      assert.equal(adopted.lanes.length, 1);
      const [lane] = adopted.lanes;
      assert.equal(lane.codex_thread_id, heartbeatThread);
      assert.equal(lane.worker_id, worker);
      assert.equal(lane.worktree_id, taskTree);
      assert.equal(lane.purpose, "Recovered native Task Goal");
      assert.equal(adopted.cycle.state, "running");
      assert.equal(
        adopted.cycle.fencing_token,
        beforeHeartbeat.cycle.fencing_token + 1,
      );
      assert.equal(
        adopted.cycle.operation_id,
        beforeHeartbeat.cycle.operation_id,
      );
      assert.equal(adopted.messages, 0);
      assert.equal(adopted.cycles, 1);
      assert.deepEqual(
        adopted.task.protected_content,
        heartbeatTask.protectedContent,
      );
      result.rawHeartbeatStates = { before: beforeHeartbeat, after: adopted };
      result.heartbeatAdoption = {
        thread: lane.codex_thread_id,
        fence: adopted.cycle.fencing_token,
        messages: adopted.messages,
        cycles: adopted.cycles,
        lane: lane.state,
      };
    } finally {
      release();
      presence = undefined;
      held = undefined;
    }
  }
  async function run(profile) {
    const sourceRoute = `/api/chats/${task}/runtime-handoffs/source`;
    const visit = (label, options) =>
      h.visit(label, "POST", sourceRoute, options);
    if (profile !== "none") {
      await visit("Task source requires authentication", {
        client: "stranger",
        status: 401,
      });
      await visit("Task source requires CSRF", { csrf: false, status: 403 });
    }
    if (profile === "accounts")
      await visit("foreign Task source is hidden", {
        client: "other",
        status: 404,
      });
    await h.visit(
      "Agent is not a Task Goal source",
      "POST",
      `/api/chats/${agent}/runtime-handoffs/source`,
      { status: 409 },
    );
    assert.equal(result.rawTaskCaptureReceipts.length, 0);
    const base = await h.snapshot();
    const settings = await openNativeSettingsSnapshot({
      service: h.encryption,
      context: base.context,
      snapshot: base,
    });
    const snapshot = async (revision) => {
      const settingsVersion = { epoch: "capture-core", revision };
      const protectedSnapshot = await protectNativeSettingsSnapshot({
        service: h.encryption,
        context: {
          chatId: task,
          workerId: worker,
          threadId: "task-thread",
          runtimeGeneration: runtime,
          settingsVersion,
        },
        settings: { ...settings, model: "goal-native", settingsVersion },
        modelAttribution: {
          status: "resolved",
          workerId: worker,
          providerId: provider,
          providerAccountId: null,
          modelId: model,
          routeId: route,
        },
      });
      assert.deepEqual(
        await openNativeSettingsSnapshot({
          service: h.encryption,
          context: protectedSnapshot.context,
          snapshot: protectedSnapshot,
        }),
        { ...settings, model: "goal-native", settingsVersion },
      );
      result.taskCryptoProofs++;
      return protectedSnapshot;
    };
    const recovery = {
      threadId: "task-thread",
      turnId: "private-goal-turn",
      taskGoalCycle: {
        cycleId,
        goalEpoch: "capture-goal",
        scopeId: "private-goal-scope",
        gateAttemptId: "private-goal-attempt",
        runnerGeneration: "capture-runner",
        modelRouteId: route,
        providerAccountId: null,
        orderEpoch: 0,
      },
    };
    const operationId =
      "native-inference:task-thread:private-goal-turn:private-goal-scope:private-goal-attempt";
    const workerGeneration = h.worker.connectionGeneration();
    const identity = {
      operationId,
      providerId: provider,
      runtimeGeneration: runtime,
      recoveryKey: recoveryQueueIdentity(task, recovery),
      recovery,
      chatId: task,
      projectId: taskProject,
    };
    const record = {
      key: digest(workerGeneration, identity),
      identity,
      workerGeneration,
      state: "waiting",
      order: 1,
      revision: 1,
      everGranted: false,
      outcome: null,
    };
    capture = taskGoalHandoffCaptureSchema.parse({
      record,
      snapshot: await snapshot("1"),
    });
    const content = {
      version: 1,
      classification: taskContent("implementing", 1, {
        hasPlan: true,
        hasFinalPlan: true,
        hasGoalPrompt: true,
      }).classification,
      briefMarkdown: marker,
      planMarkdown: marker,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: marker,
      goalPrompt: marker,
      lastError: null,
    };
    const protectedTask = await controller.protectTask(h.owner, task, content);
    await h.fixture.sql([
      `INSERT INTO tasks(chat_id,state,planning_round,has_plan,has_final_plan,has_goal_prompt,plan_goal_enabled,protected_content,implementation_started_at,model_configuration) VALUES(${literal(task)},'implementing',1,true,true,true,true,${json(protectedTask.protectedContent)},${literal(stamp)},${json(modelConfiguration)})`,
      // Source capture accepts a settled finalize cycle with a queued native
      // Goal. A running cycle would let initial attachment recover it before
      // the replacement connection we are testing.
      `INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,model_route_id,physical_worker_id,worktree_id,codex_thread_id,fencing_token,started_at,completed_at,model_configuration) VALUES(${literal(cycleId)},${literal(h.owner)},${literal(task)},'goal-capture-operation','finalize','succeeded',${literal(stamp)},${literal(route)},${literal(worker)},${literal(taskTree)},'task-thread',1,${literal(stamp)},${literal(stamp)},${json(modelConfiguration)})`,
      `UPDATE projects SET task_scheduling_paused=false,task_scheduling_paused_at=NULL WHERE id=${literal(taskProject)}`,
      `UPDATE chats SET automation_paused=false WHERE id=${literal(task)}`,
    ]);
    const captured = await visit("actual queued Task Goal source");
    assert.equal(captured.binding.chatId, task);
    assert.equal(captured.binding.runtimeGeneration, runtime);
    assert.equal(captured.binding.modelRouteId, route);
    assert.equal(
      (await visit("repeat source retains binding")).binding.bindingId,
      captured.binding.bindingId,
    );
    const readBinding = () =>
      readQuery(
        `SELECT to_jsonb(s) result FROM native_settings_states s WHERE chat_id=${literal(task)}`,
      );
    const stable = await readBinding();
    result.rawTaskStages.push({ label: "bound source", state: stable });
    for (const [mode, code] of [
      ["wrong-digest", "handoff-task-goal-source-replaced"],
      ["old-generation", "handoff-task-goal-worker-replaced"],
    ]) {
      sourceMode = mode;
      assert.equal(
        (await visit("source fence " + mode, { status: 409 })).code,
        code,
      );
      assert.deepEqual(await readBinding(), stable);
    }
    sourceMode = "valid";
    const sourceGate = hold();
    const pending = visit("changed controls fence held source", {
      status: 409,
    });
    try {
      await wait(
        () => sourceGate.requested,
        Boolean,
        "actual worker capture held",
      );
      await h.fixture.sql([
        `UPDATE chats SET managed_input_revision=managed_input_revision+1 WHERE id=${literal(task)}`,
      ]);
      release();
      assert.equal((await pending).code, "handoff-task-goal-controls-replaced");
      assert.deepEqual(await readBinding(), stable);
    } finally {
      release();
      held = undefined;
    }
    assert.equal(
      (await visit("fresh source after control change")).binding.bindingId,
      captured.binding.bindingId,
    );

    capture = { ...capture, snapshot: await snapshot("2") };
    const beforeSqlFailure = await readBinding();
    await h.fixture.sql([
      "CREATE FUNCTION reject_goal_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'actual-goal-capture-bind-rejection'; END $$",
      "CREATE TRIGGER reject_goal_capture BEFORE UPDATE ON native_settings_states FOR EACH ROW EXECUTE FUNCTION reject_goal_capture()",
    ]);
    await visit("real SQL failure after capture", { status: 500 });
    assert.deepEqual(
      await readBinding(),
      beforeSqlFailure,
      "failed source bind is rolled back byte for byte",
    );
    await h.fixture.sql([
      "DROP TRIGGER reject_goal_capture ON native_settings_states",
      "DROP FUNCTION reject_goal_capture()",
    ]);
    const rebound = await visit("retry source bind after actual SQL rollback");
    assert.equal(rebound.binding.bindingId, captured.binding.bindingId);
    assert.deepEqual(rebound.effective, capture.snapshot);
    result.rawTaskStages.push({
      label: "source bind retry",
      state: await readBinding(),
    });

    // An expired cycle without a pending input is eligible for presence
    // recovery. With no active cycles, the periodic scheduler has no owner
    // to reconcile and cannot supply the observation this case requires.
    await h.fixture.sql([
      `UPDATE task_dispatch_cycles SET state='expired' WHERE id=${literal(cycleId)}`,
    ]);
    const oldWorker = h.worker;
    const reconnectGate = hold();
    presence = {
      name: "socket reconnect",
      chatId: task,
      cycleId,
      threadId: "task-thread",
      status: "failed",
      gate: reconnectGate,
    };
    const readReconnect = () =>
      readQuery(
        `SELECT jsonb_build_object('task',to_jsonb(t),'cycle',to_jsonb(c),'queue',(SELECT to_jsonb(q) FROM managed_queue_states q WHERE q.chat_id=t.chat_id),'lanes',(SELECT count(*) FROM chat_execution_lanes l WHERE l.chat_id=t.chat_id),'messages',(SELECT count(*) FROM chat_messages WHERE chat_id=t.chat_id)) result FROM tasks t JOIN task_dispatch_cycles c ON c.chat_id=t.chat_id WHERE c.id=${literal(cycleId)}`,
      );
    const beforeReconnect = await readReconnect();
    assert.equal(beforeReconnect.queue, null);
    assert.equal(beforeReconnect.cycle.goal_cycle_recovery, null);
    try {
      await h.reconnectWorker();
      await wait(
        () => reconnectGate.requested,
        Boolean,
        "socket reconnect observes retained Task before any durable Goal wake",
      );
      assert.deepEqual(await readReconnect(), beforeReconnect);
      release();
      await wait(
        () => h.diagnostics(),
        (value) =>
          value.includes(
            "The native Task session reports a runtime error. Its history was preserved.",
          ),
        "the passive observation reports the bound native failure",
      );
      const afterReconnect = await readReconnect();
      result.rawReconnectStates = {
        before: beforeReconnect,
        after: afterReconnect,
      };
      assert.ok(
        Date.parse(afterReconnect.task.updated_at) >=
          Date.parse(beforeReconnect.task.updated_at),
      );
      assert.deepEqual(
        afterReconnect,
        {
          ...beforeReconnect,
          task: {
            ...beforeReconnect.task,
            row_version: beforeReconnect.task.row_version + 1,
            updated_at: afterReconnect.task.updated_at,
          },
        },
        "native failure does not take a lease, create a lane or replay a message",
      );
    } finally {
      release();
      presence = undefined;
      held = undefined;
      oldWorker.close();
    }
    const newGeneration = h.worker.connectionGeneration();
    assert.notEqual(newGeneration, workerGeneration);
    assert.equal(
      result.rawTaskGoalObservations[0].workerGeneration,
      newGeneration,
    );
    result.rawTaskWorkerReplacement = {
      oldGeneration: workerGeneration,
      newGeneration,
    };
    await h.fixture.sql([
      `UPDATE task_dispatch_cycles SET state='succeeded' WHERE id=${literal(cycleId)}`,
    ]);
    await runHeartbeat(content);

    recovering = taskGoalCycleRecoverySchema.parse({
      sourceKey: record.key,
      operationId,
      runtimeGeneration: runtime,
      workerGeneration,
      workerId: worker,
      providerId: provider,
      threadId: "task-thread",
      turnId: recovery.turnId,
      cycle: recovery.taskGoalCycle,
      admission: null,
    });
    const recoveryGate = hold();
    let persisted;
    try {
      await h.fixture.sql([
        `UPDATE task_dispatch_cycles SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,completed_at=${literal(stamp)},goal_cycle_recovery=${json(recovering)} WHERE id=${literal(cycleId)}`,
        `INSERT INTO managed_queue_states(chat_id,revision,notified_revision,notification_due_at) VALUES(${literal(task)},1,0,now()) ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now()`,
      ]);
      await wait(
        () => recoveryGate.requested,
        Boolean,
        "actual Task recovery notification retries stale worker generation",
      );
      const failed = await readQuery(query);
      result.rawTaskStages.push({
        label: "stale recovery ACK keeps original source",
        state: failed,
      });
      assert.deepEqual(failed.cycle.goal_cycle_recovery, recovering);
      assert.ok(failed.queue.notified_revision < failed.queue.revision);
      assert.equal(failed.messages, 0);
      assert.equal(failed.cycles, 1);
      release();
      persisted = await wait(
        () => readQuery(query),
        (value) =>
          value.cycle.goal_cycle_recovery?.admission &&
          value.queue.notified_revision === value.queue.revision,
        "Task recovery revision acknowledged",
      );
    } finally {
      release();
      held = undefined;
    }
    assert.ok(accepted);
    assert.equal(accepted.workerGeneration, newGeneration);
    assert.deepEqual(persisted.cycle.goal_cycle_recovery, {
      ...recovering,
      admission: { ...accepted.admission, workerGeneration: newGeneration },
    });
    assert.deepEqual(
      persisted.task.protected_content,
      protectedTask.protectedContent,
    );
    assert.equal(persisted.cycle.state, "running");
    assert.equal(
      persisted.cycle.fencing_token,
      beforeReconnect.cycle.fencing_token + 1,
    );
    assert.equal(persisted.messages, 0);
    assert.equal(persisted.cycles, 1);
    assert.equal(
      recoveryAttempts,
      3,
      "stale ACK, actual retry and idempotent notification of the new revision",
    );
    result.rawTaskStages.push({
      label: "scheduled recovery acknowledges durable revision",
      state: persisted,
    });
    result.taskRecovery = {
      state: persisted.cycle.state,
      fence: persisted.cycle.fencing_token,
      revision: persisted.queue.revision,
      notified: persisted.queue.notified_revision,
      recoveryAttempts,
      messages: persisted.messages,
      cycles: persisted.cycles,
    };
    for (const text of [marker, goalMarker])
      assert.equal(
        JSON.stringify([
          ...h.fixture.records.values(),
          result.rawTaskStages,
          h.live.history,
          h.diagnostics(),
        ]).includes(text),
        false,
      );
  }
  return {
    handle,
    run,
    queries: [query, heartbeatQuery],
    release: () => release?.(),
  };
}
