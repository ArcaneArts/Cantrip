export function fileDocumentWireFixtures() {
  const id = "11111111-1111-4111-8111-111111111111";
  const envelope = {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 2,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  };
  const opaque = { formatVersion: 1, keyRevision: 2, envelope };
  const input = {
    id,
    worktreeId: "worktree",
    stateProtection: {
      classification: { recordKind: "file-document-state" },
      protectedState: opaque,
    },
  };
  const summary = {
    ...input,
    projectId: "project",
    workerId: "worker",
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  return {
    fileDocumentCreateSchema: [input, { ...input, worktreeId: "\ud800" }],
    fileDocumentWireSummarySchema: [summary],
    fileDocumentWireListSchema: [[], [summary]],
    surfaceStreamWireRequestSchema: [
      { operationId: id, sequence: 0, protectedRequest: opaque },
      {
        operationId: "\ud800",
        sequence: 9007199254740991,
        protectedRequest: opaque,
      },
    ],
    surfaceStreamWireResponseSchema: [
      { operationId: id, sequence: 0, protectedResponse: opaque },
    ],
  };
}
