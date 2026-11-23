export function cantripOsWorkspaceOperationFixtures() {
  const id = "11111111-1111-4111-8111-111111111111";
  const at = "2026-11-06T00:00:00.000Z";
  const result = {
    operationId: id,
    state: "ready",
    startedAt: at,
    updatedAt: at,
    error: null,
    receipt: {
      kind: "workspace",
      workspace: {
        guestWorkspaceId: "work",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/homes/work",
      },
    },
  };
  const summary = {
    operationId: id,
    instanceId: id,
    workerId: "worker",
    guestWorkspaceId: "work",
    attachmentGeneration: id,
    runtimeGeneration: id,
    state: "ready",
    result,
    createdAt: at,
    updatedAt: at,
  };
  return {
    cantripOsWorkspaceOperationSummarySchema: [
      summary,
      { ...summary, state: "unknown", result: null },
    ],
    cantripOsWorkspaceOperationListQuerySchema: [
      {},
      { limit: "2", cursor: id },
    ],
    cantripOsWorkspaceOperationPageSchema: [
      { items: [summary], nextCursor: null },
    ],
  };
}
