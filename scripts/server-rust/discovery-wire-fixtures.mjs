export function discoveryWireFixtures(label) {
  const id = "33333333-3333-4333-8333-000000000001";
  const candidateId = "44444444-4444-4444-8444-000000000001";
  const workspaceId = "workspace-one",
    workerId = "worker-one";
  const handle = "ctrr_" + "A".repeat(43),
    at = "2026-10-25T00:00:00.000Z";
  const counts = {
    candidates: 1,
    collapsedRepositories: 0,
    rejectedRepositories: 0,
    scannedDirectories: 2,
    scannedEntries: 3,
    skippedSymlinks: 0,
    unreadableDirectories: 0,
  };
  const job = {
    id,
    workspaceId,
    workerId,
    state: "succeeded",
    stateRevision: 3,
    attempt: 1,
    depth: -1,
    diagnosticCode: null,
    truncated: false,
    counts,
    error: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    completedAt: at,
  };
  const candidate = {
    id: candidateId,
    jobId: id,
    workspaceId,
    workerId,
    pathHandle: handle,
    displayHandle: handle,
    originUrlHandle: null,
    github: null,
    repositoryFingerprint: "f".repeat(64),
    classification: "local-git",
    importState: "pending",
    diagnosticCode: null,
    createdAt: at,
    updatedAt: at,
  };
  const result = {
    candidateId,
    attempt: 1,
    path: handle,
    displayPath: handle,
    originUrl: null,
    github: null,
    repositoryFingerprint: candidate.repositoryFingerprint,
    classification: "local-git",
    diagnosticCode: null,
    branch: null,
    head: null,
  };
  const name = {
    state: "encrypted",
    formatVersion: 1,
    keyRevision: 1,
    blindIndex: Buffer.alloc(32).toString("base64url"),
    envelope: label.protectedLabel.envelope,
  };
  const workspace = {
    id: workspaceId,
    storage: { kind: "managed" },
    nameProtection: name,
    position: 1,
    isDefault: false,
    projectIds: [],
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  const opaque = label.protectedLabel;
  return {
    repositoryRoutingHandleSchema: [handle],
    workspaceRepositoryDiscoveryJobSummarySchema: [job],
    workspaceRepositoryDiscoveryCountsSchema: [counts],
    workspaceRepositoryDiscoveryProgressSchema: [
      { counts, diagnosticCode: null, truncated: false },
    ],
    workspaceRepositoryCandidateSummarySchema: [candidate],
    workspaceRepositoryCandidateClassificationSchema: ["local-git"],
    workspaceRepositoryCandidateDiagnosticCodeSchema: ["origin-invalid"],
    workspaceRepositoryDiscoverySnapshotSchema: [
      { job, candidates: [candidate] },
    ],
    workspaceRepositoryDiscoveryStartSchema: [
      {},
      { expectedStateRevision: 3, depth: 16 },
    ],
    workspaceRepositoryImportStartSchema: [
      {
        expectedStateRevision: 3,
        candidates: [{ candidateId, projectId: id, nameProtection: label }],
      },
    ],
    workspaceRepositoryDiscoveryWorkerResultSchema: [
      {
        jobId: id,
        attempt: 1,
        candidates: [
          {
            path: handle,
            displayPath: handle,
            originUrl: null,
            github: null,
            repositoryFingerprint: candidate.repositoryFingerprint,
            classification: "local-git",
            diagnosticCode: null,
          },
        ],
        counts,
        truncated: false,
        diagnosticCode: null,
      },
    ],
    workspaceRepositoryImportValidationResultSchema: [result],
    encryptedProjectWorkspaceCreateSchema: [
      { id, nameProtection: name, storage: { kind: "managed" } },
      {
        id,
        nameProtection: name,
        storage: {
          kind: "attached",
          workerId,
          rootPathHandle: handle,
          displayHandle: handle,
        },
      },
    ],
    encryptedAttachedProjectWorkspaceCreateSchema: [
      {
        id,
        nameProtection: name,
        storage: { kind: "attached", workerId },
        operationId: id,
        protectedRequest: opaque,
      },
    ],
    encryptedAttachedProjectWorkspaceCreateResultSchema: [
      { workspace, operation: { operationId: id, protectedResponse: opaque } },
    ],
    encryptedProjectWorkspaceUpdateSchema: [
      { expectedRevision: 1, isDefault: true },
      { expectedRevision: 1, nameProtection: name },
    ],
    projectWorkspaceWireSummarySchema: [workspace],
    projectWorkspaceWireListSchema: [{ workspaces: [workspace] }],
  };
}
