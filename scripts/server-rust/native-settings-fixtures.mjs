const envelope = {
  version: 1,
  algorithm: "AES-256-GCM",
  keyRevision: 1,
  nonce: Buffer.alloc(12).toString("base64url"),
  ciphertext: Buffer.alloc(32).toString("base64url"),
};
export const settingsScope = {
  chatId: "chat",
  workerId: "alpha",
  threadId: "thread",
  contextKind: "project",
  projectId: "github",
  placementId: "github-alpha-main",
  modelRouteId: null,
  providerAccountId: null,
};
export const settingsBinding = {
  ...settingsScope,
  bindingId: "binding",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
};
export const settingsSnapshot = {
  context: {
    chatId: "chat",
    workerId: "alpha",
    threadId: "thread",
    runtimeGeneration: "runtime",
    settingsVersion: { epoch: "epoch", revision: "4" },
  },
  contentFingerprint: "a".repeat(64),
  protectedContent: envelope,
};
export const settingsIntent = {
  operationId: "operation",
  operationGeneration: "generation",
  origin: "gui",
  source: {
    workerId: "alpha",
    threadId: "thread",
    runtimeGeneration: "runtime",
  },
  protectedContent: envelope,
  payloadDigest: "b".repeat(64),
};
export const resolvedAttribution = {
  selection: {
    status: "resolved",
    workerId: "alpha",
    providerId: "provider",
    providerAccountId: null,
    modelId: "model",
    routeId: "route",
  },
  fingerprint: "c".repeat(64),
};
export function nativeSettingsWireFixtures() {
  const base = {
    chatId: "chat",
    revision: "0",
    desiredRevision: "0",
    desired: null,
    desiredStatus: null,
    pending: [],
    binding: null,
    effective: null,
  };
  return {
    nativeSettingsEvidenceSchema: [
      {
        workerId: "alpha",
        operationId: "operation",
        operationGeneration: "generation",
        eventId: "12345678-1234-4234-8234-123456789abc",
        threadId: "thread",
        runtimeGeneration: "runtime",
        nativeOperationId: "settings",
        submissionId: "submission",
        kind: "applied",
        resultDigest: "a".repeat(64),
        protectedResult: envelope,
      },
      {
        workerId: "alpha",
        operationId: "operation",
        operationGeneration: "generation",
        eventId: "12345678-1234-4234-8234-123456789abc",
        threadId: "thread",
        runtimeGeneration: "runtime",
        nativeOperationId: "settings",
        submissionId: "submission",
        kind: "applied",
        resultDigest: "a".repeat(64),
        protectedResult: envelope,
        recoveryBindingId: "binding",
        permissionPolicy: {
          effectiveId: ":workspace",
          settingsVersion: { epoch: "epoch", revision: "4" },
        },
      },
    ],
    nativeSettingsEvidenceResultSchema: [
      {
        operationId: "operation",
        operationGeneration: "generation",
        eventId: "12345678-1234-4234-8234-123456789abc",
        application: {
          nativeOperationId: "settings",
          submissionId: "submission",
          status: "applied",
          evidenceCount: 1,
        },
        permissionPolicyPublished: false,
      },
    ],
    nativeSettingsObservationRequestSchema: [
      { workerId: "alpha", bindingId: "binding", snapshot: settingsSnapshot },
    ],
    nativeSettingsObservationReceiptSchema: [
      {
        bindingId: "binding",
        revision: "99999999999999999999",
        settingsVersion: { epoch: "epoch", revision: "18446744073709551615" },
      },
    ],
    nativeSettingsReadScopeSchema: [
      settingsScope,
      { ...settingsScope, contextKind: "standalone", projectId: null },
    ],
    nativeSettingsBindingSchema: [settingsBinding],
    nativeSettingsIntentSchema: [
      settingsIntent,
      {
        ...settingsIntent,
        permissionTransition: {
          selectedId: null,
          resolvedSelectedId: ":workspace",
          effectiveId: ":workspace",
          expectedRevision: "0",
        },
      },
    ],
    protectedNativeSettingsSnapshotSchema: [
      settingsSnapshot,
      { ...settingsSnapshot, modelAttribution: resolvedAttribution },
      {
        ...settingsSnapshot,
        modelAttribution: {
          selection: { status: "unmapped" },
          fingerprint: "d".repeat(64),
        },
      },
    ],
    nativeSettingsStateSchema: [
      base,
      {
        ...base,
        revision: "184467440737095516160000",
        desiredRevision: "99",
        desired: settingsIntent,
        desiredStatus: "accepted",
        pending: [
          {
            intent: settingsIntent,
            desiredRevision: "99",
            bindingId: "binding",
            status: "accepted",
          },
        ],
        binding: settingsBinding,
        effective: settingsSnapshot,
      },
    ],
    nativeSettingsVersionSchema: [
      { epoch: "epoch", revision: "0" },
      { epoch: "epoch", revision: "18446744073709551615" },
    ],
  };
}
export function nativeSettingsWireCases(name) {
  if (name === "nativeSettingsEvidenceSchema") {
    const base = nativeSettingsWireFixtures().nativeSettingsEvidenceSchema[0],
      values = [];
    for (const kind of [
      "queued",
      "applied",
      "rejected",
      "transport-lost",
      "correlation-conflict",
    ])
      for (const submissionId of [null, "submission"])
        for (const permissionPolicy of [
          undefined,
          {
            effectiveId: ":workspace",
            settingsVersion: { epoch: "epoch", revision: "4" },
          },
        ])
          for (const recoveryBindingId of [undefined, "binding"])
            values.push({
              ...base,
              kind,
              submissionId,
              ...(permissionPolicy ? { permissionPolicy } : {}),
              ...(recoveryBindingId ? { recoveryBindingId } : {}),
            });
    return values;
  }
  if (name !== "nativeSettingsVersionSchema") return [];
  return [
    "0",
    "1",
    "18446744073709551614",
    "18446744073709551615",
    "18446744073709551616",
    "99999999999999999999",
    "0001",
    "+1",
    "-1",
    "1.0",
    "1e1",
    "1\n",
    "1\r\n",
    "1\u2028",
    "1\u2029",
    "１",
  ].map((revision) => ({ epoch: "epoch", revision }));
}
