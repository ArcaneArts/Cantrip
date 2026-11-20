import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeInferenceRecoverySchema,
  nativeRuntimeHandoffConfigurationRequestSchema,
  nativeRuntimeHandoffWorkerRequestSchema,
} from "../../packages/protocol/dist/index.js";

export async function cancelTaskGoalHandoff({
  capture,
  scope,
  cycleId,
  provider,
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
    targetModelRouteId: "other-route",
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
  if (!taskGoalInput) {
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
      assert.equal(request.side, "source");
      assert.equal(state.queuedSource.withdrawn, true);
      assert.equal(state.cancelRequested, true);
      send({
        state,
        side: request.side,
        configuration: {
          cwd,
          threadId: scope.threadId,
          provider,
          model: {
            id: "gpt-5",
            name: "gpt-5",
            routeId: scope.modelRouteId,
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
            orderEpoch: cycle.orderEpoch,
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
        lostResponse = true;
        response.writeHead(503).end("{}");
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
      case "finish":
        assert.equal(request.outcome, "cancelled");
        assert.equal(state.queuedSource.withdrawn, true);
        state = { ...state, phase: "cancelled" };
        send(state);
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
    const attempted = await invoke({ ...request, intent: "continue" });
    assert.equal(
      attempted.ok,
      false,
      JSON.stringify(attempted) + "\n" + diagnostics(),
    );
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
