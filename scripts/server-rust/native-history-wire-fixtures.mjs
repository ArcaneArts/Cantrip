export function nativeHistoryWireFixtures(timestamp) {
  const binding = {
    id: "history-binding",
    chatId: "chat",
    workerId: "worker",
    threadId: "thread",
    projectId: "project",
    worktreeId: "worktree",
    modelRouteId: null,
    providerAccountId: null,
    createdFromOperationId: null,
    createdAt: timestamp,
  };
  const open = {
    workerId: "worker",
    chatId: "chat",
    threadId: "thread",
    provenance: { kind: "current" },
  };
  const identity = {
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    component: "user",
    identityKind: "canonical",
  };
  const resolve = {
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    items: [],
  };
  const operation = {
    operationId: "operation",
    operationGeneration: "generation",
  };
  const queue = { ...operation, claimId: "claim", promptRevision: 0 };
  const envelope = {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const capture = {
    threadId: "thread",
    turnId: "turn",
    isRoot: true,
    reasoningEffort: null,
    selection: { status: "unavailable" },
  };
  const turn = {
    threadId: "thread",
    turnId: "turn",
    revision: 1,
    ordinal: 0,
    status: "completed",
    startedAtMs: null,
    completedAtMs: null,
    metadata: envelope,
  };
  const message = {
    id: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "native-history:" + "a".repeat(64),
    classification: { role: "user", mode: "default", attachmentIds: [] },
    protectedContent: { formatVersion: 1, keyRevision: 1, envelope },
    reasoningEffort: null,
  };
  const prepared = {
    items: [
      {
        identity,
        revision: 1,
        expectedRevision: 0,
        state: "completed",
        order: { turn: 0, item: 0, component: 0 },
        message,
        attachments: [],
        evidence: {
          version: 1,
          bindingId: "binding",
          workerId: "worker",
          revision: 1,
          content: envelope,
        },
      },
    ],
    turns: [turn],
  };
  const ingest = {
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    streamId: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    recordId: "44444444-4444-4444-8444-444444444444",
    digest: "a".repeat(64),
    previousDigest: null,
    batch: prepared,
  };
  const receipt = {
    committed: true,
    streamId: ingest.streamId,
    sequence: 1,
    recordId: ingest.recordId,
    digest: ingest.digest,
    commitId: "55555555-5555-4555-8555-555555555555",
  };
  const snapshotId = "e".repeat(64);
  const read = { workerId: "worker", chatId: "chat", bindingId: binding.id };
  const archived = {
    key: "a".repeat(64),
    identity,
    messageId: message.id,
    attachments: [],
    revision: 2,
    state: "completed",
    order: { turn: 0, item: 0, component: 0 },
    evidence: {
      version: 1,
      bindingId: binding.id,
      workerId: "worker",
      revision: 1,
      content: envelope,
    },
  };
  return {
    nativeHistoryArchiveReadSchema: [
      read,
      {
        ...read,
        limit: 1,
        cursor: { snapshotId, key: "a".repeat(64) },
        snapshotId,
      },
    ],
    nativeHistoryArchivePageSchema: [
      {
        binding,
        snapshotId,
        items: [archived],
        nextCursor: { snapshotId, key: archived.key },
      },
      { binding, snapshotId, items: [], nextCursor: null },
    ],
    nativeHistoryTurnArchiveReadSchema: [
      read,
      {
        ...read,
        cursor: { snapshotId, bindingId: binding.id, turnId: "turn" },
      },
    ],
    nativeHistoryTurnArchivePageSchema: [
      {
        binding,
        snapshotId,
        turns: [{ bindingId: binding.id, workerId: "worker", turn }],
        nextCursor: { snapshotId, bindingId: binding.id, turnId: "turn" },
      },
    ],
    nativeHistoryBatchArchiveReadSchema: [
      read,
      {
        ...read,
        limit: 16,
        cursor: { snapshotId, streamId: ingest.streamId, sequence: 1 },
      },
    ],
    nativeHistoryBatchArchivePageSchema: [
      {
        binding,
        snapshotId,
        batches: [
          {
            bindingId: binding.id,
            workerId: "worker",
            receipt,
            payloadDigest: "a".repeat(64),
            previousDigest: null,
            batch: prepared,
          },
        ],
        nextCursor: { snapshotId, streamId: ingest.streamId, sequence: 1 },
      },
      {
        binding,
        snapshotId,
        batches: [
          {
            bindingId: binding.id,
            workerId: "worker",
            receipt,
            payloadDigest: "a".repeat(64),
            previousDigest: null,
            batch: null,
          },
        ],
        nextCursor: null,
      },
    ],
    nativeHistoryIngestSchema: [
      ingest,
      {
        ...ingest,
        batch: {
          items: [],
          turns: [],
          snapshot: { readBarrierSequence: 0, complete: true },
        },
      },
    ],
    nativeHistoryPreparedBatchSchema: [prepared, { items: [], turns: [] }],
    nativeHistoryCommitReceiptSchema: [receipt],
    nativeHistoryBatchRejectionSchema: [
      {
        rejected: true,
        rejectionId: receipt.commitId,
        workerId: ingest.workerId,
        chatId: ingest.chatId,
        bindingId: ingest.bindingId,
        streamId: ingest.streamId,
        sequence: 1,
        recordId: ingest.recordId,
        digest: ingest.digest,
        previousDigest: null,
        payloadDigest: "b".repeat(64),
        code: "item-revision-conflict",
      },
    ],
    nativeTurnModelAttributionSchema: [
      capture,
      {
        ...capture,
        reasoningEffort: "medium",
        selection: {
          status: "resolved",
          workerId: "worker",
          providerId: "provider",
          providerAccountId: null,
          modelId: "model",
          routeId: "route",
        },
      },
    ],
    nativeHistoryBindingOpenSchema: [
      open,
      ...[
        { kind: "binding", bindingId: "binding" },
        { kind: "child", parentBindingId: "parent" },
        {
          kind: "command",
          operationId: "operation",
          operationGeneration: "generation",
        },
      ].map((provenance) => ({ ...open, provenance })),
      { ...open, threadId: "😀".repeat(127) + "a" },
    ],
    nativeHistoryBindingSchema: [
      binding,
      { ...binding, ancestorThreadIds: ["root", "parent"] },
      {
        ...binding,
        ancestorThreadIds: Array.from({ length: 31 }, (_, i) => "thread-" + i),
      },
      { ...binding, createdAt: "2026-10-31T12:00:00.123-05:00" },
    ],
    nativeHistoryResolveSchema: [
      resolve,
      ...[
        { kind: "native" },
        { kind: "existing" },
        { kind: "observed-output" },
        { kind: "output", rootTurnId: "root-turn" },
        { kind: "observed-input", clientUserMessageId: "cantrip:input" },
        {
          kind: "command-input",
          ...operation,
          clientUserMessageId: "cantrip:input",
        },
        { kind: "command-output", ...operation },
        { kind: "queue-input", ...queue, clientUserMessageId: "cantrip:input" },
        { kind: "queue-goal", ...queue },
      ].map((association) => ({
        ...resolve,
        items: [{ identity, association }],
      })),
    ],
    nativeHistoryItemMappingSchema: [
      {
        key: "a".repeat(64),
        identity,
        messageId: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: "native-history:" + "a".repeat(64),
        preservedInput: null,
      },
    ],
  };
}

export function nativeHistoryWireCases(name) {
  const fixtures = nativeHistoryWireFixtures("2026-10-31T12:00:00.123Z");
  const open = fixtures.nativeHistoryBindingOpenSchema[0];
  const binding = fixtures.nativeHistoryBindingSchema[0];
  const resolve = fixtures.nativeHistoryResolveSchema[0];
  const item = fixtures.nativeHistoryResolveSchema[1].items[0];
  const batch = fixtures.nativeHistoryPreparedBatchSchema[0];
  const mismatch = {
    ...batch,
    items: [
      {
        ...batch.items[0],
        evidence: { ...batch.items[0].evidence, revision: 2 },
      },
    ],
  };
  return (
    {
      nativeHistoryArchivePageSchema: [
        {
          ...fixtures.nativeHistoryArchivePageSchema[0],
          items: [
            {
              ...fixtures.nativeHistoryArchivePageSchema[0].items[0],
              evidence: {
                ...fixtures.nativeHistoryArchivePageSchema[0].items[0].evidence,
                revision: 3,
              },
            },
          ],
        },
      ],
      nativeHistoryPreparedBatchSchema: [mismatch],
      nativeHistoryIngestSchema: [
        { ...fixtures.nativeHistoryIngestSchema[0], batch: mismatch },
      ],
      nativeHistoryBindingOpenSchema: [
        { ...open, provenance: { kind: "current", extra: true } },
        { ...open, provenance: { kind: "command", operationId: "operation" } },
        { ...open, provenance: { kind: "other" } },
        { ...open, threadId: "😀".repeat(128) },
        { ...open, extra: true },
      ],
      nativeHistoryBindingSchema: [
        { ...binding, ancestorThreadIds: [] },
        { ...binding, ancestorThreadIds: Array(32).fill("parent") },
        { ...binding, ancestorThreadIds: [""] },
        { ...binding, createdAt: "2026-10-31T12:00:00" },
        { ...binding, ownerId: "private-owner" },
      ],
      nativeHistoryResolveSchema: [
        { ...resolve, items: Array(512).fill(item) },
        { ...resolve, items: Array(513).fill(item) },
        {
          ...resolve,
          items: [
            {
              ...item,
              association: {
                kind: "command-input",
                operationId: "missing-generation",
              },
            },
          ],
        },
        {
          ...resolve,
          items: [{ ...item, identity: { ...item.identity, extra: true } }],
        },
        {
          ...resolve,
          items: [{ ...item, association: { kind: "native", extra: true } }],
        },
      ],
    }[name] ?? []
  );
}
