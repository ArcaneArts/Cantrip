import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeInferenceRecoverySchema,
  nativeRuntimeHandoffConfigurationRequestSchema,
  nativeRuntimeHandoffWorkerRequestSchema,
} from "../../packages/protocol/dist/index.js";

export async function taskGoalHandoff({
  capture,
  scope,
  cycleId,
  provider,
  target,
  interruptFinish,
  available,
  cwd,
  attach,
  attachRecovery,
  observeRecovery,
  invoke,
  diagnostics,
}) {
  const operationId = randomUUID();
  const now = new Date().toISOString();
  const source = {
    ...scope,
    bindingId: randomUUID(),
    runtimeGeneration: capture.snapshot.context.runtimeGeneration,
    nativeEpoch: capture.snapshot.context.settingsVersion.epoch,
  };
  const { record, taskGoalInput } = capture;
  const cycle = taskGoalInput ?? record.identity.recovery.taskGoalCycle;
  const taskConfiguration = { modelId: "gpt-5" };
  let state = {
    operationId,
    chatId: source.chatId,
    workerId: source.workerId,
    phase: "preparing",
    cancelRequested: false,
    source,
    binding: source,
    retiredRuntimeGenerations: [],
    retiredNativeEpochs: [],
    targetModelRouteId: target?.routeId ?? "other-route",
    targetProviderAccountId: null,
    prepared: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    queuedSource: {
      operationId: record.identity.operationId,
      operationGeneration: record.identity.runtimeGeneration,
      withdrawn: false,
      taskGoal: record,
      taskGoalControl: { taskConfiguration, cycleConfiguration: null },
      ...(taskGoalInput ? { taskGoalInput } : {}),
    },
  };
  let withdrawals = 0;
  let lostResponse = false;
  const completed = Promise.withResolvers();
  if (!taskGoalInput && !target) {
    attachRecovery((body) => {
      const request = nativeInferenceRecoverySchema.parse(body);
      if (state.phase !== "cancelled" || request.record.key !== record.key)
        return undefined;
      assert.equal(request.record.state, "released");
      assert.equal(request.record.outcome, "never-started");
      const taskGoalRecovery = {
        sourceKey: record.key,
        operationId: record.identity.operationId,
        runtimeGeneration: record.identity.runtimeGeneration,
        workerGeneration: record.workerGeneration,
        workerId: scope.workerId,
        providerId: record.identity.providerId,
        threadId: scope.threadId,
        turnId: record.identity.recovery.turnId,
        cycle,
      };
      observeRecovery(taskGoalRecovery);
      return {
        key: record.key,
        chatId: scope.chatId,
        disposition: "requeued",
        taskGoalCycleNotDispatched: true,
        taskGoalRecovery,
      };
    });
  }
  attach((path, body, response, send) => {
    if (path.endsWith("/configuration")) {
      const request =
        nativeRuntimeHandoffConfigurationRequestSchema.parse(body);
      assert.equal(request.operationId, operationId);
      assert.equal(state.queuedSource.withdrawn, true);
      assert.equal(state.cancelRequested, !target);
      const selected = request.side === "destination" ? target : undefined;
      if (request.side === "destination") assert.ok(selected);
      send({
        state,
        side: request.side,
        configuration: {
          cwd,
          threadId: scope.threadId,
          provider: selected?.provider ?? provider,
          model: {
            id: selected?.model ?? "gpt-5",
            name: selected?.model ?? "gpt-5",
            routeId: selected?.routeId ?? scope.modelRouteId,
            reasoningEffort: null,
          },
          subagentDefaults: null,
          mcpServers: [],
          planMode: "default",
          permissionProfileId: ":workspace",
          task: {
            chatId: scope.chatId,
            projectId: scope.projectId,
            worktreeId: scope.placementId,
            rootKind: "folder-root",
            computerUseEnabled: false,
            cycleId,
            goalEpoch: cycle.goalEpoch,
            orderEpoch: cycle.orderEpoch + Number(Boolean(selected)),
          },
        },
      });
      return;
    }
    const request = nativeRuntimeHandoffWorkerRequestSchema.parse(body);
    assert.equal(request.operationId, operationId);
    switch (request.action) {
      case "read":
      case "failure":
        send(state);
        break;
      case "withdrawn":
        assert.equal(withdrawals++, 0);
        assert.equal(request.record.key, record.key);
        assert.deepEqual(request.record.identity, record.identity);
        assert.deepEqual(request.record.order, record.order);
        assert.equal(request.record.state, "released");
        assert.equal(request.record.outcome, "never-started");
        state = {
          ...state,
          queuedSource: { ...state.queuedSource, withdrawn: true },
        };
        if (target) {
          send(state);
        } else {
          lostResponse = true;
          response.writeHead(503).end("{}");
        }
        break;
      case "recover":
        assert.equal(request.side, "source");
        assert.equal(request.recovered.threadId, scope.threadId);
        state = {
          ...state,
          binding: {
            ...state.binding,
            runtimeGeneration: request.recovered.runtimeGeneration,
            nativeEpoch:
              request.recovered.snapshot.context.settingsVersion.epoch,
          },
        };
        send(state);
        break;
      case "prepared":
        assert.ok(target);
        assert.equal(request.prepared.threadId, scope.threadId);
        assert.notEqual(
          request.prepared.runtimeGeneration,
          source.runtimeGeneration,
        );
        state = { ...state, phase: "prepared", prepared: request.prepared };
        send(state);
        break;
      case "commit":
        assert.ok(target);
        assert.equal(state.phase, "prepared");
        state = {
          ...state,
          phase: "committed",
          binding: {
            ...source,
            bindingId: randomUUID(),
            modelRouteId: target.routeId,
            runtimeGeneration: state.prepared.runtimeGeneration,
            nativeEpoch: state.prepared.snapshot.context.settingsVersion.epoch,
          },
          retiredRuntimeGenerations: [source.runtimeGeneration],
        };
        send(state);
        break;
      case "finish":
        assert.equal(request.outcome, target ? "completed" : "cancelled");
        assert.equal(state.queuedSource.withdrawn, true);
        state = { ...state, phase: request.outcome };
        if (interruptFinish) completed.resolve(state);
        else send(state);
        break;
      default:
        assert.fail("Unexpected Task handoff action " + request.action);
    }
  });
  try {
    const request = {
      type: "chat.runtime.handoff",
      chatId: scope.chatId,
      operationId,
    };
    const ongoing = invoke(
      { ...request, intent: "continue" },
      undefined,
      undefined,
      Boolean(interruptFinish),
    );
    if (interruptFinish) {
      const durable = await available(
        Promise.race([
          completed.promise,
          ongoing.then((reply) => assert.fail(JSON.stringify(reply))),
        ]),
      );
      assert.equal(durable.phase, "completed");
      assert.equal(withdrawals, 1);
      await interruptFinish();
      assert.equal((await ongoing).disconnected, true);
      return durable;
    }
    const attempted = await ongoing;
    assert.equal(
      attempted.ok,
      Boolean(target),
      JSON.stringify(attempted) + "\n" + diagnostics(),
    );
    if (target) {
      assert.equal(attempted.result.phase, "completed");
      assert.equal(withdrawals, 1);
      return attempted.result;
    }
    assert.equal(lostResponse, true, diagnostics());
    state = { ...state, cancelRequested: true };
    const cancelled = await invoke({ ...request, intent: "cancel" });
    assert.equal(
      cancelled.ok,
      true,
      JSON.stringify(cancelled) + "\n" + diagnostics(),
    );
    assert.equal(cancelled.result.phase, "cancelled");
    assert.equal(withdrawals, 1);
  } finally {
    attach(undefined);
  }
}
