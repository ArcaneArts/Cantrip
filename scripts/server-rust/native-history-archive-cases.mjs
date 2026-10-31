import assert from "node:assert/strict";
import { nativeHistoryIngestSchema } from "../../packages/protocol/dist/index.js";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { literal, json, stamp, otherOwner } from "./project-target-state.mjs";
export async function runHistoryArchiveCases(h) {
  const { call, seed, snapshot, unchanged, roots, pair, owner, afterReopen } =
    h;
  const read = (kind, name, input = {}, error) =>
    call(
      name,
      (i) => ({
        op: "native-history-archive" + kind,
        input: {
          workerId: "alpha",
          chatId: "chat",
          bindingId: roots[i].id,
          ...(typeof input === "function" ? input(i) : input),
        },
      }),
      error,
    );
  await unchanged(
    "opaque archive reads do not acquire or settle execution",
    async () => {
      const items = await read("", "read exact committed item evidence");
      for (const page of items) {
        assert.ok(page.items.length >= 2);
        const user = page.items.find((i) => i.identity.itemId === "ingested-0");
        assert.equal(user.revision, 3);
        assert.equal(user.evidence.revision, 2);
      }
      const turns = await read("-turns", "read retained complete turn headers");
      for (const page of turns) {
        assert.equal(page.turns.length, 1);
        assert.equal(page.turns[0].turn.turnId, "ingestion-turn");
        assert.equal(page.turns[0].turn.status, "completed");
      }
      const pages = [];
      let cursors;
      do {
        const results = await read(
          "-batches",
          "page retained immutable accepted batches",
          (i) => ({ limit: 2, cursor: cursors?.[i] ?? null }),
        );
        pages.push(results);
        cursors = results.map((r) => r.nextCursor);
        assert.equal(Boolean(cursors[0]), Boolean(cursors[1]));
      } while (cursors[0]);
      for (let i = 0; i < 2; i++) {
        const batches = pages.flatMap((p) => p[i].batches);
        assert.equal(batches.length, 8);
        assert.deepEqual(
          batches.map((b) => b.receipt.sequence),
          [1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert.equal(batches[0].batch.items.length, 2);
        assert.equal(
          batches[0].batch.items[0].message.protectedContent.envelope.algorithm,
          "AES-256-GCM",
        );
      }
      await read(
        "-turns",
        "caller cannot pin an unrelated snapshot",
        { snapshotId: "0".repeat(64) },
        "archive-snapshot-changed",
      );
    },
  );
  const originals = [];
  for (const r of pair) {
    const q = await r.request({
      op: "query-json",
      sql: "SELECT protected_batch result FROM native_history_receipts WHERE stream_id='aaaaaaaa-1111-4111-8111-111111111111' AND sequence=1",
    });
    assert.equal(q.rejected, false, q.diagnostic);
    originals.push(q.value);
  }
  await seed(
    "UPDATE native_history_receipts SET protected_batch=NULL WHERE stream_id='aaaaaaaa-1111-4111-8111-111111111111' AND sequence=1",
  );
  const legacy = await read(
    "-batches",
    "legacy missing source batch stays missing",
    { limit: 1 },
  );
  for (const p of legacy) assert.equal(p.batches[0].batch, null);
  await seed(
    (i) =>
      `UPDATE native_history_receipts SET protected_batch=${json(originals[i])} WHERE stream_id='aaaaaaaa-1111-4111-8111-111111111111' AND sequence=1`,
  );
  const beforeMissing = await snapshot("before missing archived message");
  const originalMessageIds = [];
  for (const r of pair) {
    const q = await r.request({
      op: "query-json",
      sql: "SELECT to_jsonb(message_id) result FROM native_history_items WHERE thread_id='root' AND item_id='ingested-0'",
    });
    assert.equal(q.rejected, false, q.diagnostic);
    originalMessageIds.push(q.value);
  }
  // A committed mapping cannot be represented as an empty recovered transcript.
  await seed(
    "UPDATE native_history_items SET message_id='99999999-7777-4777-8777-777777777777' WHERE thread_id='root' AND item_id='ingested-0'",
  );
  await read(
    "",
    "committed mapping requires the actual saved message",
    {},
    "archived-message-unavailable",
  );
  await seed(
    (i) =>
      `UPDATE native_history_items SET message_id=${literal(originalMessageIds[i])} WHERE thread_id='root' AND item_id='ingested-0'`,
  );
  assert.deepEqual(
    await snapshot("restore exact archived message reference"),
    beforeMissing,
  );
  // Deterministic legacy binding IDs isolate C-collation pagination from each
  // implementation's independently generated UUIDs. Actual ingest writes all headers.
  const bindingIds = ["archive-order-a", "archive-order-z"];
  for (const [index, worker] of ["alpha", "beta"].entries()) {
    await seed(
      `INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,project_id,worktree_id,created_at) VALUES(${literal(bindingIds[index])},${literal(owner)},${literal(worker)},'chat','archive-order-thread','github',${literal("github-" + worker + "-main")},${literal(stamp)})`,
    );
  }
  const envelope = retainedPrompt().pendingMessage.protectedContent.envelope;
  const headers = (worker, revision = 1) =>
    ["z", "é", "😀"].map((turnId, ordinal) => ({
      threadId: "archive-order-thread",
      turnId,
      revision,
      ordinal,
      status: worker === "alpha" ? "completed" : "interrupted",
      startedAtMs: null,
      completedAtMs: null,
      metadata: {
        ...envelope,
        ciphertext: Buffer.alloc(32, worker === "alpha" ? 1 : 2).toString(
          "base64url",
        ),
      },
    }));
  const streams = [
    "ffffffff-1111-4111-8111-111111111111",
    "ffffffff-2222-4222-8222-222222222222",
  ];
  const request = (index, sequence = 1) =>
    nativeHistoryIngestSchema.parse({
      workerId: index === 0 ? "alpha" : "beta",
      chatId: "chat",
      bindingId: bindingIds[index],
      streamId: streams[index],
      sequence,
      recordId: `ffffffff-3333-4333-8333-${(index * 10 + sequence).toString().padStart(12, "0")}`,
      digest: sequence.toString(16).padStart(64, "0"),
      previousDigest:
        sequence === 1 ? null : (sequence - 1).toString(16).padStart(64, "0"),
      batch: {
        items: [],
        turns: headers(index === 0 ? "alpha" : "beta", sequence),
      },
    });
  for (let i = 0; i < 2; i++)
    await call(
      "actual independent writer commits native turn candidates " + i,
      { op: "native-history-ingest", input: request(i) },
    );
  const shared = await call(
    "archive preserves accepted batches from both workers",
    {
      op: "native-history-archive-batches",
      input: { workerId: "alpha", chatId: "chat", bindingId: bindingIds[0] },
    },
  );
  for (const p of shared) {
    assert.deepEqual(
      p.batches.map((b) => b.workerId),
      ["alpha", "beta"],
    );
    assert.deepEqual(
      p.batches.map((b) => b.batch.turns.length),
      [3, 3],
    );
  }
  const ordered = [];
  let cursor = null,
    firstPages;
  do {
    const pages = await call("binary cursor order across historical workers", {
      op: "native-history-archive-turns",
      input: {
        workerId: "alpha",
        chatId: "chat",
        bindingId: bindingIds[0],
        limit: 1,
        cursor,
      },
    });
    firstPages ??= pages;
    ordered.push(pages);
    cursor = pages[0].nextCursor;
  } while (cursor);
  for (let i = 0; i < 2; i++) {
    const turns = ordered.flatMap((p) => p[i].turns);
    assert.equal(turns.length, 6);
    assert.deepEqual(
      turns.map((t) => [t.bindingId, t.turn.turnId]),
      bindingIds.flatMap((id) => ["z", "é", "😀"].map((turn) => [id, turn])),
    );
    assert.deepEqual(
      turns.map((t) => t.workerId),
      ["alpha", "alpha", "alpha", "beta", "beta", "beta"],
    );
  }
  await unchanged(
    "archive authorization requires exact owned binding",
    async () => {
      await call(
        "archive foreign owner",
        {
          op: "native-history-archive",
          owner: otherOwner,
          input: {
            workerId: "alpha",
            chatId: "chat",
            bindingId: bindingIds[0],
          },
        },
        "chat-not-found",
        404,
      );
      await call(
        "archive wrong worker",
        {
          op: "native-history-archive-turns",
          input: { workerId: "beta", chatId: "chat", bindingId: bindingIds[0] },
        },
        "binding-not-found",
        404,
      );
    },
  );
  await call("actual stream advancement invalidates pinned archive cursor", {
    op: "native-history-ingest",
    input: request(0, 2),
  });
  await call(
    "stale binary archive cursor is rejected",
    {
      op: "native-history-archive-turns",
      input: {
        workerId: "alpha",
        chatId: "chat",
        bindingId: bindingIds[0],
        cursor: firstPages[0].nextCursor,
      },
    },
    "archive-snapshot-changed",
  );
  const empty = await call(
    "empty archive remains an authorized pinned observation",
    {
      op: "native-history-archive",
      input: { workerId: "alpha", chatId: "chat", bindingId: bindingIds[0] },
    },
  );
  for (const p of empty) assert.deepEqual(p.items, []);
  afterReopen.push(() =>
    unchanged("committed opaque archive survives process restart", () =>
      read("-batches", "accepted source batches after restart", { limit: 16 }),
    ),
  );
}
