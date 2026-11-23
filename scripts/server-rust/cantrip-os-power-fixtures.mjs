export function cantripOsPowerFixtures() {
  const id = "11111111-1111-4111-8111-111111111111";
  const at = "2026-11-06T00:00:00.000Z";
  const before = {
    containerId: "a".repeat(64),
    running: true,
    status: "running",
    startedAt: at,
    finishedAt: "0001-01-01T00:00:00Z",
  };
  const after = { ...before, running: false, status: "exited", finishedAt: at };
  const { containerId: _id, ...publicState } = after;
  const target = {
    kind: "docker",
    generation: id,
    instanceId: id,
    workerId: "worker",
    attachmentGeneration: id,
    verifiedAt: at,
  };
  const input = {
    operationId: id,
    action: "stop",
    attachmentGeneration: id,
    targetGeneration: id,
  };
  const receipt = {
    targetGeneration: id,
    containerId: before.containerId,
    before,
    after,
    completionEvidence: "acknowledged-and-observed",
  };
  const result = {
    operationId: id,
    action: "stop",
    state: "ready",
    startedAt: at,
    updatedAt: at,
    error: null,
    receipt,
    observation: after,
    observationError: null,
  };
  const summary = {
    ...input,
    instanceId: id,
    workerId: "worker",
    state: "ready",
    createdAt: at,
    updatedAt: at,
    error: null,
    completionEvidence: "acknowledged-and-observed",
    powerState: publicState,
  };
  const commandTarget = {
    scope: {
      ownerId: "owner",
      serverId: "server",
      workerId: "worker",
      instanceId: id,
      guestInstanceId: id,
      attachmentGeneration: id,
      runtimeGeneration: id,
    },
    transport: { kind: "docker", container: "fixture" },
    powerTarget: {
      kind: "docker",
      generation: id,
      containerId: before.containerId,
    },
  };
  return {
    cantripOsDockerCarrierSchema: [
      { kind: "docker", containerId: before.containerId },
    ],
    cantripOsPowerTargetSchema: [commandTarget.powerTarget],
    cantripOsPowerObservationSchema: [before, after],
    cantripOsPowerActionSchema: ["start", "stop", "restart"],
    cantripOsPowerEvidenceSchema: [
      "acknowledged-and-observed",
      "observed-state",
    ],
    cantripOsPowerCreateSchema: [input],
    cantripOsPowerTargetSummarySchema: [target],
    cantripOsPowerStatusSchema: [
      { target, observation: publicState, error: null },
      { target: null, observation: null, error: "No carrier control path." },
    ],
    cantripOsPowerSummarySchema: [
      summary,
      {
        ...summary,
        state: "unknown",
        completionEvidence: null,
        powerState: null,
      },
    ],
    cantripOsPowerListQuerySchema: [{}, { limit: "1", cursor: id }],
    cantripOsPowerPageSchema: [
      { items: [summary], nextCursor: id },
      { items: [], nextCursor: null },
    ],
    cantripOsPowerReceiptSchema: [receipt],
    cantripOsPowerOperationResultSchema: [
      result,
      {
        ...result,
        state: "unknown",
        error: "Unknown delivery",
        receipt: null,
        observation: null,
      },
    ],
    cantripOsPowerWorkerCommandSchema: [
      { ...commandTarget, type: "cantrip-os.power.status" },
      {
        ...commandTarget,
        type: "cantrip-os.power.operation",
        mode: "execute",
        operationId: id,
        action: "stop",
      },
      {
        ...commandTarget,
        type: "cantrip-os.power.operation",
        mode: "observe",
        operationId: id,
        action: "restart",
      },
    ],
  };
}
