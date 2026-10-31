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
  return {
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
}
