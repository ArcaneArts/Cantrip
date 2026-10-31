export function standaloneChatWireFixtures(timestamp) {
  const titleProtection = {
    classification: { recordKind: "chat" },
    protectedLabel: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "A".repeat(16),
        ciphertext: "A".repeat(43),
      },
    },
  };
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    rootId: "22222222-2222-4222-8222-222222222222",
    chatId: "33333333-3333-4333-8333-333333333333",
    workerId: "fixture-worker",
    kind: "provision",
    state: "queued",
    stateRevision: 1,
    attempt: 0,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };
  return {
    encryptedStandaloneChatCreateSchema: [
      { id: job.chatId, titleProtection },
      { id: job.chatId, titleProtection, autoTitle: true },
    ],
    archivedStandaloneChatWireSummarySchema: [
      {
        id: job.chatId,
        contextKind: "standalone",
        projectId: null,
        titleProtection,
        experience: "agent",
        messageCount: 0,
        archivedAt: timestamp,
        expiresAt: "2027-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    standaloneChatScratchProvisionResultSchema: [
      {
        status: "ready",
        jobId: job.id,
        attempt: 1,
        rootId: job.rootId,
        chatId: job.chatId,
        path: "ctrr_" + "a".repeat(43),
        displayPath: "ctrr_" + "b".repeat(43),
        reused: false,
      },
    ],
    standaloneChatScratchDeleteResultSchema: [
      {
        jobId: job.id,
        attempt: 1,
        rootId: job.rootId,
        chatId: job.chatId,
        deleted: true,
      },
    ],
    standaloneChatScratchReconciliationResultSchema: [
      {
        retainedRootIds: [],
        missingRootIds: [],
        orphanedRootIds: [],
        dueRootIds: [],
      },
      {
        retainedRootIds: [job.rootId],
        missingRootIds: [job.id],
        orphanedRootIds: [job.chatId],
        dueRootIds: [job.rootId],
      },
    ],
    standaloneChatRootJobSummarySchema: [
      job,
      {
        ...job,
        kind: "delete",
        state: "running",
        attempt: 1,
        startedAt: timestamp,
      },
      { ...job, state: "succeeded", attempt: 1, completedAt: timestamp },
      ...[
        "worker-offline",
        "capability-missing",
        "worker-error",
        "invalid-result",
        "root-conflict",
      ].map((code) => ({
        ...job,
        state: "blocked",
        error: { code, retryable: true },
      })),
    ],
  };
}
