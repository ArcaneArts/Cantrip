import * as p from "../../packages/protocol/dist/index.js";

// Shared valid seeds for both the focused import oracle and the full wire suite.
export function chatImportWireFixtures(chatLabel, stamp) {
  const id = "33333333-3333-4333-8333-000000000001",
    attachmentId = "44444444-4444-4444-8444-000000000001";
  const attachment = {
    id: attachmentId,
    sourceAttachmentId: "a".repeat(64),
    itemId: "user",
    sizeBytes: 128,
    status: "available",
    protectedMetadata: chatLabel.protectedLabel,
  };
  const transcript = p.externalChatTranscriptSchema.parse({
    sourceId: "b".repeat(64),
    sourceThreadId: "external",
    titleProtection: chatLabel,
    metadata: {
      sourceThreadId: "external",
      preview: "History 😀 \ud800\u2028",
      cwd: "/project",
      createdAt: stamp,
      updatedAt: stamp,
      source: "vscode",
      status: "not-loaded",
      modelProvider: "openai",
      cliVersion: "0.149.0",
      git: null,
      match: {
        kind: "worktree-path",
        projectReplicaId: "replica",
        worktreeId: "tree",
      },
    },
    sync: {
      threadId: "external",
      status: "idle",
      turns: [
        {
          id: "turn",
          status: "completed",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
          items: [
            {
              type: "userMessage",
              id: "user",
              text: "User 😀 \ud800\u2029",
              externalAttachmentIds: [attachmentId],
            },
          ],
        },
      ],
    },
    attachments: [attachment],
  });
  const placement = {
    projectId: "project",
    workerId: "worker",
    projectReplicaId: "replica",
    worktreeId: "tree",
    surface: null,
  };
  const job = {
    id,
    projectId: "project",
    chatId: null,
    sourceKind: "chatgpt-codex",
    sourceWorkerId: "worker",
    sourceId: "b".repeat(64),
    sourceThreadId: "external",
    targetPlacement: placement,
    managedThreadId: null,
    targetModelRouteId: null,
    targetProviderAccountId: null,
    state: "queued",
    stateRevision: 1,
    idempotencyKey: "key",
    attempt: 0,
    progress: { stage: "queued", percent: 0, updatedAt: stamp },
    error: null,
    sourceMetadata: null,
    attachmentCount: 0,
    attachmentWarningCount: 0,
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: null,
    completedAt: null,
  };
  const selection = {
    sourceKind: "chatgpt-codex",
    sourceWorkerId: "worker",
    sourceId: "b".repeat(64),
    sourceThreadId: "external",
    idempotencyKey: "key",
  };
  const samples = {
    chatImportJobSummarySchema: [job],
    chatImportJobListSchema: [[job]],
    chatImportCreateSchema: [{ imports: [selection] }],
    chatImportJobRetrySchema: [{ stateRevision: 1 }],
    externalChatImportReferenceSchema: [
      { jobId: id, projectId: "project", chatId: null, state: "queued" },
    ],
    externalChatAttachmentSchema: [attachment],
    externalChatTranscriptSchema: [transcript],
    externalChatReadWorkerResultSchema: [{ transcript }],
    externalChatAttachmentReadResultSchema: [
      { status: "unavailable", reasonCode: "changed" },
      {
        status: "available",
        sizeBytes: 128,
        chunk: {
          sequence: 0,
          plaintextBytes: 128,
          eof: true,
          envelope: chatLabel.protectedLabel.envelope,
        },
      },
    ],
    externalChatDiscoveryWorkerResultSchema: [
      { sources: [], truncated: false },
    ],
    projectExternalChatDiscoverySchema: [
      {
        projectId: "project",
        observedAt: stamp,
        partial: false,
        truncated: false,
        workers: [],
      },
    ],
  };
  return { samples, attachment, transcript, selection, job, attachmentId };
}
