import assert from "node:assert/strict";
import { nativeHistoryIngestSchema } from "../../packages/protocol/dist/index.js";
import {
  retainedPrompt,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import { runHistoryUsageCases } from "./native-history-usage-cases.mjs";

export async function runHistoryIngestionCases(h) {
  const { call, seed, snapshot, unchanged, roots, pair, afterReopen } = h;
  await runHistoryUsageCases(h);
  const thread = "root",
    turnId = "ingestion-turn";
  const identities = ["user", "assistant"].map((component, index) => ({
    threadId: thread,
    turnId,
    itemId: "ingested-" + index,
    component,
    identityKind: "canonical",
  }));
  const mappings = await call(
    "resolve actual canonical batch identities",
    (i) => ({
      op: "native-history-resolve",
      input: {
        workerId: "alpha",
        chatId: "chat",
        bindingId: roots[i].id,
        items: identities.map((identity) => ({
          identity,
          association: { kind: "native" },
        })),
      },
    }),
  );
  const original = retainedPrompt().pendingMessage;
  const envelope = original.protectedContent.envelope;
  const cipher = (character) =>
    Buffer.alloc(32, character.charCodeAt(0)).toString("base64url");
  const body = (character) => ({
    ...original.protectedContent,
    envelope: { ...envelope, ciphertext: cipher(character) },
  });
  const prepared = (
    i,
    index,
    {
      revision = 1,
      expectedRevision = 0,
      state = "completed",
      character = "A",
      withEvidence = true,
      ...extra
    } = {},
  ) => ({
    identity: identities[index],
    revision,
    ...(expectedRevision === null ? {} : { expectedRevision }),
    state,
    order: { turn: 0, item: index, component: 0 },
    message: {
      ...original,
      id: mappings[i][index].messageId,
      idempotencyKey: mappings[i][index].idempotencyKey,
      classification: {
        ...original.classification,
        role: index === 0 ? "user" : "assistant",
      },
      reasoningEffort: index === 0 ? null : "low",
      protectedContent: body(character),
    },
    attachments: [],
    ...(withEvidence
      ? {
          evidence: {
            version: 1,
            bindingId: roots[i].id,
            workerId: "alpha",
            revision,
            content: envelope,
          },
        }
      : {}),
    ...extra,
  });
  const capture = {
    threadId: thread,
    turnId,
    isRoot: true,
    reasoningEffort: "medium",
    selection: { status: "unavailable" },
  };
  const counts = (n) => ({
    totalTokens: n,
    inputTokens: n - 2,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
  });
  const usage = (entries, complete) => ({
    version: 1,
    modelAttribution: capture,
    responses: entries.map(([responseId, n]) => ({
      responseId,
      usage: counts(n),
    })),
    complete,
    conflictingResponseIds: [],
  });
  const turn = {
    threadId: thread,
    turnId,
    revision: 1,
    ordinal: 0,
    status: "completed",
    startedAtMs: Date.parse(stamp),
    completedAtMs: Date.parse(stamp) + 1000,
    metadata: envelope,
    modelAttribution: capture,
    usage: usage([["response-a", 10]], false),
  };
  const streamId = "aaaaaaaa-1111-4111-8111-111111111111";
  let serial = 0;
  const batch = (
    sequence,
    items,
    turns = [],
    previousDigest = sequence === 1
      ? null
      : (sequence - 1).toString(16).padStart(64, "0"),
  ) => {
    const recordId =
      "bbbbbbbb-1111-4111-8111-" + (++serial).toString().padStart(12, "0");
    return (i) =>
      nativeHistoryIngestSchema.parse({
        workerId: "alpha",
        chatId: "chat",
        bindingId: roots[i].id,
        streamId,
        sequence,
        recordId,
        digest: sequence.toString(16).padStart(64, "0"),
        previousDigest,
        batch: {
          items: typeof items === "function" ? items(i) : items,
          turns: typeof turns === "function" ? turns(i) : turns,
        },
      });
  };
  const ingest = (name, input, error) =>
    call(
      name,
      (i) => ({
        op: "native-history-ingest",
        input: typeof input === "function" ? input(i) : input,
      }),
      error,
    );
  const raw = async (sql) => {
    const result = [];
    for (const r of pair) {
      const response = await r.request({ op: "query-json", sql });
      assert.equal(response.rejected, false, response.diagnostic);
      result.push(response.value);
    }
    return result;
  };
  await unchanged("invalid canonical batches commit nothing", async () => {
    await ingest(
      "batch thread mismatch",
      batch(1, (i) => [
        {
          ...prepared(i, 0),
          identity: { ...identities[0], threadId: "wrong" },
        },
      ]),
      "batch-thread-mismatch",
    );
    await ingest(
      "unresolved canonical item",
      batch(1, (i) => [
        {
          ...prepared(i, 0),
          identity: { ...identities[0], itemId: "unresolved" },
        },
      ]),
      "item-not-resolved",
    );
    await ingest(
      "canonical message identity mismatch",
      batch(1, (i) => [
        {
          ...prepared(i, 0),
          message: {
            ...prepared(i, 0).message,
            id: "99999999-1111-4111-8111-111111111111",
          },
        },
      ]),
      "item-message-identity-conflict",
    );
    await ingest(
      "evidence cannot borrow another binding",
      batch(1, (i) => [
        {
          ...prepared(i, 0),
          evidence: { ...prepared(i, 0).evidence, bindingId: "other" },
        },
      ]),
      "item-evidence-binding-mismatch",
    );
    await ingest(
      "foreign attachment cannot be imported",
      batch(1, (i) => [
        {
          ...prepared(i, 0),
          attachments: [deferredAttachment("foreign", "other-chat")],
        },
      ]),
      "item-attachment-mismatch",
    );
  });
  const first = batch(1, (i) => [prepared(i, 0), prepared(i, 1)], [turn]);
  const guiUsage = (name, record = {}) =>
    call(name, {
      op: "native-command-gui-telemetry",
      action: "usage",
      record: {
        sourceKey: "history-gui-attempt",
        projectId: "github",
        chatId: "chat",
        modelRouteId: "",
        workerId: "alpha",
        providerAccountId: null,
        turnId,
        nativeModelAttribution: capture,
        attemptStatus: "running",
        startedAt: stamp,
        ...record,
      },
    });
  await guiUsage(
    "real GUI usage bootstrap precedes canonical history ingestion",
  );
  await seed([
    "CREATE FUNCTION native_history_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled receipt failure' USING ERRCODE='23514'; END $$",
    "CREATE TRIGGER native_history_receipt_fault BEFORE INSERT ON native_history_receipts FOR EACH ROW EXECUTE FUNCTION native_history_fail_receipt()",
  ]);
  await unchanged(
    "receipt SQL failure rolls back transcript usage and stream",
    () =>
      ingest("actual receipt constraint failure", first, {
        databaseCode: "23514",
      }),
  );
  await seed([
    "DROP TRIGGER native_history_receipt_fault ON native_history_receipts",
    "DROP FUNCTION native_history_fail_receipt()",
  ]);
  const accepted = await ingest(
    "canonical items usage checkpoint and publication commit together",
    first,
  );
  for (const receipt of accepted) {
    assert.equal(receipt.committed, true);
    assert.equal(receipt.sequence, 1);
  }
  let state = await snapshot(
    "committed canonical transcript and durable publication",
  );
  for (const s of state) {
    assert.equal(s.streams.length, 1);
    assert.equal(s.receipts.length, 1);
    assert.equal(s.publications.length, 1);
    assert.equal(s.usage.length, 1);
    assert.equal(s.usage[0].input_tokens, 8);
    assert.equal(s.usage[0].attempt_status, "completed");
    assert.equal(s.usage[0].model_id, null);
    assert.equal(s.usage[0].usage_semantics, "native-responses-partial-v1");
  }
  for (const [i, r] of pair.entries()) {
    const response = await r.request({
      op: "query-json",
      sql: `SELECT jsonb_agg(jsonb_build_object('id',id,'body',protected_content,'applied',applied_reasoning_effort,'adjusted',reasoning_adjusted) ORDER BY sequence) result FROM chat_messages WHERE id IN(${mappings[i].map((m) => literal(m.messageId)).join(",")})`,
    });
    assert.equal(response.rejected, false, response.diagnostic);
    assert.equal(response.value.length, 2);
    for (const row of response.value) {
      assert.deepEqual(row.body, body("A"));
      assert.equal(row.applied, "medium");
      assert.equal(row.adjusted, row.id === mappings[i][1].messageId);
    }
  }
  await unchanged(
    "lost response replay never repeats canonical writes",
    async () => {
      assert.deepEqual(await ingest("same immutable receipt", first), accepted);
    },
  );
  afterReopen.push(() =>
    unchanged("receipt replay survives process restart", async () =>
      assert.deepEqual(
        await ingest("original receipt after reopen", first),
        accepted,
      ),
    ),
  );
  await unchanged("receipt and stream identities are fenced", async () => {
    await ingest(
      "receipt changed payload rejected",
      (i) => ({
        ...first(i),
        batch: {
          ...first(i).batch,
          items: [prepared(i, 0, { character: "B" })],
        },
      }),
      "batch-receipt-conflict",
    );
    await ingest(
      "another stream requires recovery",
      (i) => ({
        ...first(i),
        streamId: "cccccccc-1111-4111-8111-111111111111",
      }),
      "stream-recovery-required",
    );
    await ingest(
      "sequence gap rejected",
      batch(3, []),
      "batch-sequence-conflict",
    );
    await ingest(
      "previous digest must match",
      batch(2, [], [], "f".repeat(64)),
      "batch-sequence-conflict",
    );
  });
  const active = {
    ...turn,
    revision: 2,
    status: "inProgress",
    startedAtMs: null,
    completedAtMs: null,
    metadata: { ...envelope, ciphertext: cipher("B") },
    usage: usage(
      [
        ["response-a", 10],
        ["response-b", 20],
      ],
      true,
    ),
  };
  await ingest(
    "stale active header enriches independent usage",
    batch(2, [], [active]),
  );
  state = await snapshot(
    "terminal header stays closed while response evidence advances",
  );
  for (const s of state) {
    assert.equal(s.historyTurns[0].status, "completed");
    assert.equal(s.historyTurns[0].revision, 1);
    assert.equal(s.usage[0].input_tokens, 26);
    assert.equal(s.usage[0].reported_total_tokens, 30);
    assert.equal(s.usage[0].attempt_status, "completed");
    assert.equal(s.usage[0].usage_semantics, "native-responses-complete-v1");
  }
  const rejection = batch(
    3,
    [],
    [{ ...turn, metadata: { ...envelope, ciphertext: cipher("C") } }],
  );
  const decisions = await ingest(
    "same turn revision cannot rewrite retained evidence",
    rejection,
    "turn-revision-conflict",
  );
  for (const decision of decisions) {
    assert.equal(decision.rejected, true);
    assert.equal(decision.sequence, 3);
  }
  const rejectedState = await snapshot(
    "revision decision commits without source content or checkpoint",
  );
  for (const s of rejectedState) {
    assert.equal(s.rejections.length, 1);
    assert.equal(s.receipts.length, 2);
    assert.equal(s.streams[0].acknowledged_sequence, 2);
  }
  await unchanged("rejected record is immutable", async () => {
    assert.deepEqual(
      await ingest(
        "repeat rejection returns exact decision",
        rejection,
        "turn-revision-conflict",
      ),
      decisions,
    );
    await ingest(
      "rejected record cannot change content",
      (i) => ({
        ...rejection(i),
        batch: { ...rejection(i).batch, turns: [turn] },
      }),
      "batch-rejection-conflict",
    );
  });
  const terminal = {
    ...turn,
    revision: 2,
    metadata: { ...envelope, ciphertext: cipher("D") },
    usage: active.usage,
  };
  await ingest(
    "later valid terminal revision can commit",
    batch(3, [], [terminal]),
  );
  await unchanged(
    "old rejection stays final after revisions advance",
    async () =>
      assert.deepEqual(
        await ingest(
          "permanent decision before new stream head",
          rejection,
          "turn-revision-conflict",
        ),
        decisions,
      ),
  );
  afterReopen.push(() =>
    unchanged("immutable rejection survives restart", async () =>
      assert.deepEqual(
        await ingest(
          "same rejection after restart",
          rejection,
          "turn-revision-conflict",
        ),
        decisions,
      ),
    ),
  );
  await ingest(
    "CAS cannot reuse an already committed basis",
    batch(4, (i) => [prepared(i, 0)]),
    "item-revision-conflict",
  );
  await ingest(
    "new canonical item revision uses exact basis",
    batch(4, (i) => [
      prepared(i, 0, { revision: 2, expectedRevision: 1, character: "B" }),
      prepared(i, 1, { revision: 2, expectedRevision: 1, character: "B" }),
    ]),
  );
  await ingest(
    "legacy older item snapshot is acknowledged without rewriting",
    batch(5, (i) => [
      prepared(i, 0, { revision: 1, expectedRevision: null, character: "C" }),
    ]),
  );
  const stale = batch(6, (i) => [
    prepared(i, 0, {
      revision: 3,
      expectedRevision: null,
      state: "started",
      character: "C",
    }),
  ]);
  await ingest("legacy active item cannot reopen completed history", stale);
  state = await snapshot(
    "legacy stale snapshots preserve terminal item revision",
  );
  for (const s of state)
    for (const identity of identities) {
      const row = s.items.find(
        (r) =>
          r.thread_id === identity.threadId &&
          r.turn_id === identity.turnId &&
          r.item_id === identity.itemId,
      );
      assert.equal(row.revision, 2);
      assert.equal(row.state, "completed");
    }
  await ingest(
    "CAS active item cannot reopen completed history",
    batch(7, (i) => [
      prepared(i, 0, { revision: 3, expectedRevision: 2, state: "started" }),
    ]),
    "item-revision-conflict",
  );
  await ingest(
    "legacy revision retains original archival evidence",
    batch(7, (i) => [
      prepared(i, 0, {
        revision: 3,
        expectedRevision: 2,
        withEvidence: false,
        character: "D",
      }),
    ]),
  );
  state = await snapshot(
    "archived evidence is retained without relabeling its revision",
  );
  for (const s of state) {
    const row = s.items.find((r) => r.item_id === identities[0].itemId);
    assert.equal(row.revision, 3);
    assert.equal(row.protected_evidence.revision, 2);
  }
  await unchanged("canonical role cannot be retagged", () =>
    ingest(
      "existing user cannot become assistant",
      batch(8, (i) => [
        {
          ...prepared(i, 0, { revision: 4, expectedRevision: 3 }),
          message: {
            ...prepared(i, 0, { revision: 4, expectedRevision: 3 }).message,
            classification: { ...original.classification, role: "assistant" },
          },
        },
      ]),
      "item-canonical-message-conflict",
    ),
  );
  // The same response identity is never added twice during retained replay.
  await ingest(
    "complete usage replay stays deduplicated",
    batch(8, [], [{ ...terminal, revision: 3 }]),
  );
  await guiUsage(
    "late GUI finalizer shares canonical turn identity and retains measured history",
    {
      attemptStatus: "failed",
      reasoningEffort: "high",
      usage: { totalTokens: 999, inputTokens: 999, outputTokens: 0 },
      nativeModelAttribution: undefined,
    },
  );
  const usageRows = await raw(
    "SELECT jsonb_agg(jsonb_build_object('input',input_tokens,'total',reported_total_tokens,'status',attempt_status) ORDER BY source_key) result FROM token_usage_records",
  );
  for (const rows of usageRows)
    assert.deepEqual(rows, [{ input: 26, total: 30, status: "completed" }]);
  // All unrelated execution state remains under the native admission authority.
  const final = await snapshot(
    "canonical ingestion leaves native commands and lanes intact",
  );
  for (let i = 0; i < 2; i++)
    for (const key of [
      "commands",
      "activations",
      "lanes",
      "runtimes",
      "queues",
      "leases",
    ]) {
      assert.deepEqual(final[i][key], rejectedState[i][key]);
    }
  h.lastAcceptedSequence = 8;
}
