export function folderWireFixtures(label) {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const handle = "ctrr_" + "A".repeat(43);
  const at = "2026-10-25T00:00:00.000Z";
  const opaque = {
    formatVersion: 1,
    keyRevision: 1,
    envelope: label.protectedLabel.envelope,
  };
  return {
    repositoryWorkerOperationWireRequestSchema: [
      { scopeId: projectId, operationId: jobId, protectedRequest: opaque },
      {
        scopeId: projectId,
        operationId: jobId,
        protectedRequest: opaque,
        access: "read",
        agent: false,
      },
      {
        scopeId: projectId,
        operationId: jobId,
        protectedRequest: opaque,
        agent: true,
        modelId: "model",
      },
    ],
    repositoryOperationWireResponseSchema: [
      { operationId: jobId, protectedResponse: opaque },
      { operationId: jobId, protectedResponse: opaque, agentExecution: null },
    ],
    encryptedManagedFolderProjectCreateSchema: [
      { id: projectId, workerId: "folder-worker", nameProtection: label },
      {
        id: projectId,
        workerId: "folder-worker",
        nameProtection: label,
        existingPath: handle,
        workspaceId: projectId,
      },
    ],
    projectFolderSetupJobSummarySchema: [
      "queued",
      "running",
      "blocked",
      "succeeded",
      "failed",
    ].flatMap((state) => [
      {
        id: jobId,
        projectId,
        workerId: "folder-worker",
        state,
        stateRevision: 1,
        attempt: 0,
        error: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        completedAt: null,
      },
      {
        id: jobId,
        projectId,
        workerId: "folder-worker",
        state,
        stateRevision: 2,
        attempt: 1,
        error: { code: "worker-offline", retryable: true },
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]),
    projectFolderSetupRetrySchema: [
      { stateRevision: 1 },
      { stateRevision: 2147483648 },
    ],
    managedFolderMaterializeReadySchema: [
      {
        status: "ready",
        jobId,
        attempt: 1,
        path: handle,
        displayPath: handle,
        reused: false,
      },
      {
        status: "ready",
        jobId,
        attempt: 2,
        path: handle,
        displayPath: handle,
        reused: true,
        repositoryFingerprint: "a".repeat(64),
        github: null,
      },
    ],
    projectWorkspaceStorageContextSchema: [
      { kind: "system" },
      { kind: "legacy" },
      { kind: "managed", workspaceId: projectId },
      { kind: "attached", workspaceId: projectId, workerId: "folder-worker" },
    ],
  };
}
