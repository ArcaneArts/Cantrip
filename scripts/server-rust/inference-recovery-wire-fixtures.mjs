// Canonical admission, physical failure and outcome delivery contracts. These
// contain operational identities and synthetic encrypted payloads only.
import { nativeGoalRecoveryWireFixtures } from "./native-goal-recovery-fixtures.mjs";
const id = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const receipt = {
  operationId: id,
  chatId: "fixture-chat",
  clientMessageId: "fixture-message",
  workerId: "fixture-worker",
  worktreeId: "fixture-worktree",
  executionLaneId: "fixture-lane",
  executionLaneActivatedAt: "2026-11-05T00:00:00.000Z",
  providerId: "fixture-provider",
  modelRouteId: "fixture-route",
  providerAccountId: null,
  dispatch: {
    cycleId: id,
    operationId: "fixture-round",
    leaseOwner: "fixture-server",
    fencingToken: 1,
  },
};
const receipts = [receipt, { ...receipt, kind: "goal" }];
const failure = {
  operationId: id,
  chatId: receipt.chatId,
  messageId: receipt.clientMessageId,
  providerId: receipt.providerId,
};
const failures = [
  {
    ...failure,
    disposition: "input-not-dispatched",
    runtimeGeneration: null,
    threadId: null,
    turnId: null,
    nativeScopeId: null,
  },
  {
    ...failure,
    disposition: "model-failed-before-output",
    runtimeGeneration: generation,
    threadId: "fixture-thread",
    turnId: "fixture-turn",
    nativeScopeId: id,
  },
];
const notification = {
  type: "chat.turn.outcome",
  chatId: receipt.chatId,
  clientMessageId: receipt.clientMessageId,
  executionLaneId: receipt.executionLaneId,
  worktreeId: receipt.worktreeId,
  taskInferenceInputOperationId: id,
  taskDispatchFence: receipt.dispatch,
};
const notifications = [
  ...failures.map((inference) => ({
    ...notification,
    outcome: { ok: false, error: "Controlled failure", inference },
  })),
  {
    ...notification,
    nativeLogicalRoot: { operationId: id, operationGeneration: generation },
    outcome: {
      ok: true,
      result: { threadId: "fixture-thread", text: "", status: "completed" },
    },
  },
  {
    ...notification,
    contextKind: "standalone",
    worktreeId: null,
    scratchRootId: "fixture-scratch-root",
    outcome: { ok: false, error: "Controlled standalone failure" },
  },
];
const authorization = {
  serverId: "fixture-server",
  ownerId: "fixture-owner",
  workerId: receipt.workerId,
  workerGeneration: generation,
};
const authorizations = [
  { ...authorization, target: { kind: "chat", chatId: receipt.chatId } },
  {
    ...authorization,
    target: { kind: "project", projectId: "fixture-project" },
  },
];
const routeRequest = {
  operationId: generation,
  inputOperationId: receipt.operationId,
  expectedRevision: 1,
  targetModelRouteId: "fixture-next-route",
  targetProviderAccountId: null,
};
const routeChanges = receipts.flatMap((source) =>
  ["draining", "completed", "cancelled"].map((phase) => ({
    ...routeRequest,
    source,
    phase,
    queuedFencingToken: 0,
    createdAt: "2026-11-05T00:00:00.000Z",
    completedAt: phase === "draining" ? null : "2026-11-05T00:00:01.000Z",
  })),
);

export const inferenceRecoveryWireFixtures = {
  taskInferenceRouteChangeRequestSchema: [
    routeRequest,
    { ...routeRequest, targetProviderAccountId: "fixture-account" },
  ],
  taskInferenceRouteChangeSchema: routeChanges,
  taskInferenceRouteViewSchema: [
    {
      chatId: receipt.chatId,
      revision: 1,
      source: null,
      latest: null,
      providers: [],
    },
    ...routeChanges.map((latest) => ({
      chatId: receipt.chatId,
      revision: 2,
      source: latest.source,
      latest,
      providers: [],
    })),
  ],
  taskInferenceRouteSettlementSchema: receipts.flatMap((source) =>
    [false, true].map((settled) => ({
      ...authorization,
      operationId: routeRequest.operationId,
      source,
      settled,
    })),
  ),
  inferenceFailureEvidenceSchema: failures,
  nativeInferenceRecoverySchema: ["waiting", "granted", "released"].map(
    (state, index) => ({
      serverId: authorization.serverId,
      workerId: receipt.workerId,
      workerGeneration: generation,
      record: {
        key: "a".repeat(64),
        identity: {
          operationId: id,
          providerId: receipt.providerId,
          runtimeGeneration: generation,
          recoveryKey: "fixture-recovery",
          recovery: { messageId: receipt.clientMessageId, taskInput: receipt },
          chatId: receipt.chatId,
          projectId: "fixture-project",
        },
        workerGeneration: generation,
        state,
        order: index + 1,
        revision: index + 1,
        everGranted: state !== "waiting",
        ...(state !== "waiting"
          ? {
              nativeExecution: {
                threadId: "thread",
                turnId: "turn",
                scopeId: "scope",
              },
            }
          : {}),
        outcome: state === "released" ? "never-started" : null,
      },
    }),
  ),
  nativeInferenceRecoveryResultSchema: [
    "requeued",
    "retired",
    "unresolved",
  ].flatMap((disposition) => [
    { key: "a".repeat(64), disposition, chatId: null },
    {
      key: "a".repeat(64),
      disposition,
      chatId: receipt.chatId,
      taskInputNotDispatched: true,
    },
  ]),
  nativeInferenceResourceAuthorizationSchema: authorizations,
  nativeInferenceResourceAuthorizationResultSchema: authorizations.map(
    (value) => ({ ...value, authorized: true }),
  ),
  taskInferenceInputReceiptSchema: receipts,
  taskInferenceInputDispatchSchema: receipts.flatMap((receipt) =>
    [undefined, "accepted", "claim", "dispatch"].map((phase) => ({
      serverId: authorization.serverId,
      workerId: receipt.workerId,
      workerGeneration: generation,
      receipt,
      ...(phase ? { phase } : {}),
    })),
  ),
  taskInferenceInputDispatchResultSchema: receipts.map((receipt) => ({
    receipt,
  })),
  tunnelOsPrepareResultSchema: [
    { identity: "a".repeat(64) },
    {
      identity: "b".repeat(64),
      ssh: {
        user: "cantrip",
        hostAlias: `cantrip-os-${id}`,
        hostKey: `ssh-ed25519 ${"A".repeat(68)}`,
      },
    },
  ],
  taskGoalOutcomeDeliverySchema: notifications.flatMap((notification) =>
    [undefined, "round", "goal"].map((inputKind) => ({
      version: 1,
      ...(inputKind ? { inputKind } : {}),
      deliveryId: id,
      serverId: authorization.serverId,
      ownerId: authorization.ownerId,
      workerId: authorization.workerId,
      notification,
    })),
  ),
  taskGoalOutcomeCommitSchema: [
    { deliveryId: id, taskInferenceInputOperationId: id, committed: true },
    { deliveryId: id, taskInferenceInputOperationId: id, committed: false },
    ...[
      "canonical-input-deleted",
      "canonical-input-replaced",
      "canonical-input-deferred",
    ].map((retiredReason) => ({
      deliveryId: id,
      taskInferenceInputOperationId: id,
      committed: false,
      retiredReason,
    })),
  ],
  workerChatTurnOutcomeNotificationSchema: notifications,
  inferenceCommandTimingSchema: [
    {
      queueWaitMs: 0,
      preparationMs: 0,
      executionMs: 0,
      suspendedMs: 0,
      complete: false,
    },
    {
      queueWaitMs: 1,
      preparationMs: 2,
      executionMs: 3,
      suspendedMs: 4,
      complete: true,
    },
    {
      queueWaitMs: Number.MAX_SAFE_INTEGER,
      preparationMs: 0,
      executionMs: 0,
      suspendedMs: 0,
      complete: true,
    },
  ],
};

const goalAdmission =
  nativeGoalRecoveryWireFixtures().nativeGoalRecoveryAdmissionSchema[0];
const goalSource =
  nativeGoalRecoveryWireFixtures().nativeGoalRecoverySourceSchema[0];
const goalRequest =
  inferenceRecoveryWireFixtures.nativeInferenceRecoverySchema[0];
inferenceRecoveryWireFixtures.nativeInferenceRecoverySchema.push(
  ...[0, 1, Number.MAX_SAFE_INTEGER].map((orderEpoch) => ({
    ...goalRequest,
    record: {
      ...goalRequest.record,
      identity: {
        ...goalRequest.record.identity,
        operationId: goalSource.operationId,
        recovery: {
          commandId: goalSource.operationId,
          commandGeneration: goalSource.operationGeneration,
          threadId: goalSource.threadId,
          autonomousGoal: { goalEpoch: goalSource.goalEpoch, orderEpoch },
        },
      },
    },
  })),
);
inferenceRecoveryWireFixtures.nativeInferenceRecoverySchema.push(
  ...inferenceRecoveryWireFixtures.nativeInferenceRecoverySchema.map(
    (value) => ({
      ...value,
      expectedGoalAdmission: goalAdmission,
    }),
  ),
);
inferenceRecoveryWireFixtures.nativeInferenceRecoveryResultSchema.push(
  ...[false, true].flatMap((goalInputNotDispatched) =>
    [undefined, goalAdmission].map((goalOwnershipChallenge) => ({
      key: "a".repeat(64),
      disposition: "unresolved",
      chatId: receipt.chatId,
      goalInputNotDispatched,
      ...(goalOwnershipChallenge ? { goalOwnershipChallenge } : {}),
    })),
  ),
);
