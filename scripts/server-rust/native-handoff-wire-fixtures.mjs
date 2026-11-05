import {
  settingsBinding,
  settingsSnapshot,
  resolvedAttribution,
} from "./native-settings-fixtures.mjs";
import { autonomousAttempts } from "./native-command-wire-fixtures.mjs";
import { nativeGoalRecoveryWireFixtures } from "./native-goal-recovery-fixtures.mjs";
export const handoffOperation = "77777777-7777-4777-8777-000000000077";
export function handoffPrepared(extra = {}) {
  return {
    threadId: "thread",
    runtimeGeneration: "target-runtime",
    snapshot: {
      ...settingsSnapshot,
      context: {
        ...settingsSnapshot.context,
        runtimeGeneration: "target-runtime",
        settingsVersion: { epoch: "target-core", revision: "0" },
      },
      modelAttribution: resolvedAttribution,
    },
    ...extra,
  };
}
export function nativeHandoffWireFixtures(timestamp) {
  const goalRecoverySource =
    nativeGoalRecoveryWireFixtures().nativeGoalRecoverySourceSchema[0];
  const goalWithdrawal = {
    operationId: handoffOperation,
    source: goalRecoverySource,
    bindingId: "binding",
    runtimeGeneration: "source-runtime",
    runnerGeneration: "source-runner",
    workerGeneration: "22222222-2222-4222-8222-222222222222",
  };
  const prepared = handoffPrepared();
  const request = {
    operationId: handoffOperation,
    bindingId: "binding",
    targetModelRouteId: "route",
    targetProviderAccountId: null,
  };
  const state = {
    operationId: handoffOperation,
    chatId: "chat",
    workerId: "alpha",
    phase: "prepared",
    source: settingsBinding,
    binding: settingsBinding,
    targetModelRouteId: "route",
    targetProviderAccountId: null,
    prepared,
    errorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const worker = {
    workerId: "alpha",
    chatId: "chat",
    operationId: handoffOperation,
  };
  const queuedStates = [false, true].flatMap((withdrawn) =>
    autonomousAttempts.map((autonomousAttempt) => ({
      ...state,
      phase: "preparing",
      binding: null,
      prepared: null,
      queuedSource: {
        operationId: "queued-goal",
        operationGeneration: "queued-generation",
        withdrawn,
        autonomousAttempt,
        ...(withdrawn
          ? { retargetedPrompt: { id: "prompt", revision: 0 } }
          : {}),
      },
    })),
  );
  queuedStates.push(
    ...[false, true].map((withdrawn) => ({
      ...state,
      phase: "preparing",
      binding: null,
      prepared: null,
      queuedSource: {
        operationId: goalRecoverySource.operationId,
        operationGeneration: goalRecoverySource.operationGeneration,
        withdrawn,
        autonomousAttempt: autonomousAttempts[1],
        goalRecovery: goalRecoverySource,
        ...(withdrawn ? { goalWithdrawal } : {}),
      },
    })),
    ...[false, true].map((withdrawn) => ({
      ...state,
      phase: "preparing",
      binding: null,
      prepared: null,
      queuedSource: {
        operationId: "queued-goal-claim",
        operationGeneration: "queued-generation",
        withdrawn,
        goalClaim: {
          id: "goal-claim",
          promptId: "goal-prompt",
          promptRevision: 0,
          operationId: "goal-setter",
          operationGeneration: "goal-setter-generation",
          goalEpoch: "goal-epoch",
        },
        ...(withdrawn ? { autonomousAttempt: autonomousAttempts[1] } : {}),
      },
    })),
  );
  const fixtures = {
    nativeGoalRecoveryWithdrawalSchema: [goalWithdrawal],
    nativeRuntimeHandoffRequestSchema: [request],
    nativeRuntimeHandoffPreparedSchema: [
      prepared,
      { ...prepared, reasoningEffort: null },
      { ...prepared, reasoningEffort: "high" },
    ],
    nativeRuntimeHandoffStateSchema: [
      state,
      { ...state, phase: "preparing", binding: null, prepared: null },
      ...queuedStates,
    ],
    nativeRuntimeHandoffInventorySchema: [
      {
        chatId: "chat",
        binding: settingsBinding,
        latest: state,
        providers: [],
      },
      ...queuedStates.map((latest) => ({
        chatId: "chat",
        binding: settingsBinding,
        latest,
        providers: [],
      })),
    ],
    nativeRuntimeHandoffWorkerRequestSchema: [
      { ...worker, action: "read" },
      { ...worker, action: "goal-recovery-withdrawn", receipt: goalWithdrawal },
      {
        ...worker,
        action: "prepared",
        prepared,
        expectedPreparedRuntimeGeneration: null,
      },
      {
        ...worker,
        action: "recover",
        side: "source",
        expectedBindingId: "binding",
        recovered: prepared,
      },
      { ...worker, action: "commit" },
      { ...worker, action: "finish", outcome: "completed" },
      { ...worker, action: "failure", errorCode: "worker-unavailable" },
    ],
    nativeRuntimeHandoffConfigurationRequestSchema: [
      { ...worker, side: "source" },
    ],
    nativeRuntimeHandoffConfigurationSchema: [
      {
        state,
        side: "destination",
        configuration: {
          session: {
            chatId: "chat",
            computerUseEnabled: false,
            contextKind: "project",
            projectId: "github",
            worktreeId: "github-alpha-main",
            rootKind: "git-worktree",
            scratchRootId: null,
          },
          threadId: "thread",
          cwd: "/fixture",
          model: {
            id: "model",
            routeId: "route",
            name: "model",
            reasoningEffort: null,
          },
          provider: {
            id: "provider",
            name: "provider",
            kind: "openai-compatible",
            baseUrl: "http://localhost:8080",
            protectedApiKey: null,
            accountId: null,
            credentialHomeKey: null,
          },
          subagentDefaults: null,
          mcpServers: [],
          planMode: "default",
          permissionProfileId: ":workspace",
        },
      },
    ],
  };
  fixtures.nativeRuntimeHandoffConfigurationSchema.push(
    ...queuedStates.map((state) => ({
      ...fixtures.nativeRuntimeHandoffConfigurationSchema[0],
      state,
    })),
  );
  return fixtures;
}
