import { nativeGoalRecoveryWireFixtures } from "./native-goal-recovery-fixtures.mjs";
export const autonomousAttempts = [
  {
    runnerGeneration: "runner",
    attemptId: "attempt",
    turnId: "turn",
    trigger: "goal",
  },
  {
    runnerGeneration: "runner",
    attemptId: "attempt",
    turnId: "turn",
    trigger: "goal",
    goalEpoch: "goal-epoch",
  },
];

export function nativeCommandWireFixtures(timestamp) {
  const session = {
    chatId: "chat",
    threadId: "thread",
    contextKind: "project",
    projectId: "project",
    placementId: "worktree",
    modelRouteId: null,
    providerAccountId: null,
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  const receipt = {
    operationId: "operation",
    operationGeneration: "generation",
    logicalOperationId: null,
    previousOperationId: null,
    activationGeneration: null,
    chatId: "chat",
    startsExecution: false,
    executionLaneId: null,
    status: "accepted",
    method: "skills/list",
    payloadDigest: "a".repeat(64),
    rejectionCode: null,
    threadId: "thread",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const fixtures = {
    nativeAutonomousAttemptSchema: autonomousAttempts,
    nativePermissionTransitionResolveSchema: [
      { workerId: "worker", session, selectedId: null },
      { workerId: "worker", session, selectedId: ":read-only" },
    ],
    nativeCommandContinuationSchema: [
      ...["native-terminal", "native-rejected"].map((kind) => ({
        workerId: "worker",
        rootOperationId: "root",
        previousOperationId: "previous",
        previousOperationGeneration: "generation",
        operationId: "next",
        payloadDigest: "b".repeat(64),
        protectedPayload: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(32).toString("base64url"),
        },
        session,
        reason: kind === "native-terminal" ? "capacity" : "invalid-compaction",
        failure:
          kind === "native-terminal"
            ? { kind, nativeTurnId: "turn", runtimeGeneration: "runtime" }
            : {
                kind,
                method: "thread/resume",
                code: -32000,
                runtimeGeneration: "runtime",
              },
        ...(kind === "native-rejected"
          ? {
              handoff: {
                expectedThreadId: "old",
                replacementThreadId: "thread",
              },
            }
          : {}),
      })),
    ],
    nativeCommandAdmissionSchema: [
      {
        workerId: "worker",
        operationId: "operation",
        origin: "gui",
        session,
        method: "turn/start",
        payloadDigest: "a".repeat(64),
        protectedPayload: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(32).toString("base64url"),
        },
        expectedActivationGeneration: null,
        intent: { scope: "thread" },
      },
      {
        workerId: "worker",
        operationId: "operation",
        origin: "gui",
        session: {
          ...session,
          threadId: null,
          runtimeGeneration: null,
          connectionId: null,
        },
        method: "turn/start",
        payloadDigest: "a".repeat(64),
        protectedPayload: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(32).toString("base64url"),
        },
        expectedActivationGeneration: null,
        intent: { scope: "thread" },
        queueClaim: { id: "claim", promptRevision: 1 },
      },
    ],
    nativePendingRequestSchema: [
      {
        workerId: "worker",
        session,
        activationGeneration: "activation",
        nativeRequestId: "request",
        requestMethod: "item/commandExecution/requestApproval",
        turnId: null,
      },
    ],
    nativeCommandDispatchSchema: [
      {
        workerId: "worker",
        operationId: "operation",
        operationGeneration: "generation",
        payloadDigest: "a".repeat(64),
        session,
      },
    ],
    nativeCommandSessionSchema: [
      session,
      {
        ...session,
        contextKind: "standalone",
        projectId: null,
        placementId: "scratch",
      },
    ],
    nativeCommandIntentSchema: [
      {
        scope: "thread",
        settingKeys: ["permissions"],
        permissionTransition: {
          selectedId: null,
          resolvedSelectedId: ":workspace",
          effectiveId: ":workspace",
          expectedRevision: "0",
        },
      },
      { scope: "thread" },
      {
        scope: "account-defaults",
        configTarget: "account-defaults",
        settingKeys: ["model", "service_tier"],
      },
      {
        scope: "thread",
        settingsBindingId: "binding",
        nativeSettingsOperationId: "settings",
      },
    ],
    nativeCommandReceiptSchema: [
      receipt,
      {
        ...receipt,
        startsExecution: true,
        status: "applied",
        method: "turn/start",
        activationGeneration: "active",
        settingsApplication: {
          nativeOperationId: "settings",
          submissionId: null,
          status: "pending",
          evidenceCount: 0,
        },
      },
    ],
  };
  fixtures.nativeCommandAdmissionSchema.push(
    ...fixtures.nativeCommandAdmissionSchema.flatMap((admission) =>
      autonomousAttempts.map((autonomousAttempt) => ({
        ...admission,
        intent: { ...admission.intent, autonomousAttempt },
      })),
    ),
  );
  fixtures.nativeCommandIntentSchema.push(
    ...fixtures.nativeCommandIntentSchema.flatMap((intent) =>
      autonomousAttempts.map((autonomousAttempt) => ({
        ...intent,
        autonomousAttempt,
      })),
    ),
  );
  const recovery = nativeGoalRecoveryWireFixtures();
  const goalRecovery = recovery.nativeGoalRecoverySourceSchema[0];
  const workerGeneration =
    recovery.nativeGoalRecoveryAdmissionSchema[0].workerGeneration;
  const goalIntent = {
    scope: "thread",
    autonomousAttempt: {
      ...autonomousAttempts[1],
      goalEpoch: goalRecovery.goalEpoch,
    },
    goalRecovery,
    workerGeneration,
  };
  fixtures.nativeCommandIntentSchema.push(goalIntent);
  fixtures.nativeCommandAdmissionSchema.push({
    ...fixtures.nativeCommandAdmissionSchema[0],
    origin: "autonomous",
    session: { ...session, threadId: goalRecovery.threadId },
    intent: goalIntent,
  });
  fixtures.nativeCommandDispatchSchema.push({
    ...fixtures.nativeCommandDispatchSchema[0],
    workerGeneration,
  });
  return fixtures;
}
