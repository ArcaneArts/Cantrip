export function cantripOsDesktopFixtures() {
  const id = "11111111-1111-4111-8111-111111111111";
  const at = "2026-11-06T00:00:00.000Z";
  const before = {
    id: "work",
    user: "ctw-work",
    uid: 20000,
    gid: 20000,
    home: "/homes/work",
    display: 100,
    generation: 1,
    desktop_generation: "a".repeat(64),
    status: "running",
  };
  const after = { ...before, status: "stopped" };
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: id,
    guestInstanceId: id,
    attachmentGeneration: id,
    runtimeGeneration: id,
    workspaceId: id,
    guestWorkspaceId: "work",
    uid: 20000,
    gid: 20000,
    homeGuestPath: before.home,
  };
  const request = {
    operation_id: id,
    action: "stop",
    scope_key: "b".repeat(64),
    target: before,
  };
  const guestReceipt = {
    before,
    after,
    completion: "acknowledged-and-observed",
  };
  const receipt = {
    before,
    after,
    targetGeneration: id,
    completionEvidence: "acknowledged-and-observed",
  };
  const input = {
    operationId: id,
    action: "stop",
    attachmentGeneration: id,
    runtimeGeneration: id,
    targetGeneration: id,
  };
  const summary = {
    ...input,
    instanceId: id,
    workspaceId: id,
    workerId: "worker",
    state: "ready",
    createdAt: at,
    updatedAt: at,
    error: null,
    completionEvidence: "acknowledged-and-observed",
  };
  const target = {
    generation: id,
    instanceId: id,
    workspaceId: id,
    workerId: "worker",
    attachmentGeneration: id,
    runtimeGeneration: id,
    verifiedAt: at,
  };
  const capture = {
    scope,
    transport: { kind: "docker", container: "fixture" },
  };
  return {
    cantripOsDesktopActionSchema: ["start", "stop", "restart"],
    cantripOsGuestDesktopTargetSchema: [
      before,
      after,
      { ...after, generation: 0, desktop_generation: null },
    ],
    cantripOsDesktopScopeSchema: [scope],
    cantripOsGuestDesktopRequestSchema: [request],
    cantripOsGuestDesktopReceiptSchema: [guestReceipt],
    cantripOsGuestDesktopResultSchema: [
      {
        version: 1,
        request,
        state: "ready",
        started_at: at,
        updated_at: at,
        error: null,
        receipt: guestReceipt,
        current: after,
        current_error: null,
      },
    ],
    cantripOsDesktopWorkerCommandSchema: [
      { ...capture, type: "cantrip-os.desktop.status" },
      {
        ...capture,
        type: "cantrip-os.desktop.operation",
        mode: "execute",
        operationId: id,
        action: "stop",
        targetGeneration: id,
        desktopTarget: before,
      },
      {
        ...capture,
        type: "cantrip-os.desktop.operation",
        mode: "observe",
        operationId: id,
        action: "stop",
        targetGeneration: id,
        desktopTarget: before,
      },
    ],
    cantripOsDesktopReceiptSchema: [receipt],
    cantripOsDesktopOperationResultSchema: [
      {
        operationId: id,
        action: "stop",
        state: "ready",
        startedAt: at,
        updatedAt: at,
        error: null,
        receipt,
        observation: after,
        observationError: null,
      },
      ...["running", "unknown", "failed"].map((state) => ({
        operationId: id,
        action: "stop",
        state,
        startedAt: at,
        updatedAt: at,
        error: "No verified receipt.",
        receipt: null,
        observation: null,
        observationError: "Disconnected.",
      })),
    ],
    cantripOsDesktopCreateSchema: [input],
    cantripOsDesktopTargetSummarySchema: [target],
    cantripOsDesktopStatusSchema: [
      { target, observation: { status: "running" }, error: null },
      { target: null, observation: null, error: "Unavailable." },
    ],
    cantripOsDesktopSummarySchema: [summary],
    cantripOsDesktopListQuerySchema: [{}, { limit: 3, cursor: id }],
    cantripOsDesktopPageSchema: [{ items: [summary], nextCursor: null }],
  };
}
