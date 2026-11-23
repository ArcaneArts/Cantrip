export function chatRelocationWireFixtures(fixtures, at) {
  const id = "33333333-3333-4333-8333-000000000001";
  const sourcePlacement = {
    projectId: "project",
    workerId: "source-worker",
    projectReplicaId: "source-replica",
    worktreeId: "source-tree",
    surface: null,
  };
  const targetPlacement = {
    ...sourcePlacement,
    workerId: "target-worker",
    projectReplicaId: "target-replica",
    worktreeId: "target-tree",
  };
  const snapshot = {
    id,
    chatId: "chat",
    sourcePlacement,
    throughSequence: 1,
    transcriptSha256: "a".repeat(64),
    messageCount: 1,
    attachmentCount: 0,
    modelId: null,
    modelRouteId: null,
    permissionProfileId: null,
    requiredRevision: " " + "A".repeat(40) + " ",
    createdAt: at,
  };
  const job = {
    id,
    projectId: "project",
    chatId: "chat",
    state: "queued",
    stateRevision: 1,
    idempotencyKey: "key",
    sourcePlacement,
    sourcePlacementRevision: 1,
    targetPlacement,
    contextSnapshotId: id,
    targetRuntimeThreadId: null,
    targetModelRouteId: null,
    attempt: 0,
    progress: { stage: "queued", percent: 0, updatedAt: at },
    error: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    cancellationUnsafeAt: null,
    completedAt: null,
  };
  return {
    chatRelocationJobSummarySchema: [job],
    chatRelocationJobListSchema: [[], [job]],
    chatRelocationSnapshotSummarySchema: [snapshot],
    chatRelocationContextPayloadSchema: [
      {
        version: 1,
        messages: [
          {
            sequence: 1,
            role: "user",
            mode: "default",
            content: [{ type: "text", text: "History 😀 \ud800" }],
            createdAt: at,
          },
        ],
        attachments: [],
      },
      ...["task-encrypted", "chat-encrypted"].map((kind) => ({
        version: 1,
        kind,
        messages: [],
        attachments: [],
      })),
    ],
    chatRelocationCreateSchema: fixtures.executionTargetSchema.map(
      (target) => ({ target, approved: true, idempotencyKey: " key " }),
    ),
    chatRelocationJobRetrySchema: [{ stateRevision: 1 }],
    chatRelocationJobCancelSchema: [{ stateRevision: 1 }],
    chatRelocationHydrationBeginResultSchema: [
      { status: "upload" },
      { status: "hydrated", threadId: "thread" },
    ],
    chatRelocationHydrationResultSchema: [false, true].map((reused) => ({
      snapshotId: id,
      transcriptSha256: snapshot.transcriptSha256,
      threadId: "thread",
      reused,
    })),
  };
}
