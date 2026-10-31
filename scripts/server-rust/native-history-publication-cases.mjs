import assert from "node:assert/strict";
import { literal, stamp, otherOwner } from "./project-target-state.mjs";

export async function runHistoryPublicationCases({
  call,
  seed,
  snapshot,
  pair,
  owner,
  afterReopen,
}) {
  // Give actual ingestion-created receipts a deterministic due order. The
  // publication implementation still performs its own database clock filter.
  await seed(
    `WITH ordered AS (SELECT p.commit_id,row_number() OVER(ORDER BY b.chat_id,b.thread_id,b.worker_id,r.stream_id,r.sequence) n FROM native_history_publications p INNER JOIN native_history_bindings b ON b.id=p.binding_id INNER JOIN native_history_receipts r ON r.commit_id=p.commit_id) UPDATE native_history_publications p SET attempts=0,next_attempt_at=${literal(stamp)}::timestamptz+o.n*interval '1 millisecond' FROM ordered o WHERE p.commit_id=o.commit_id`,
  );
  const list = (name, limit = 64) =>
    call(name, { op: "native-history-publications", limit });
  const pending = await list(
    "list actual committed publications in durable due order",
  );
  for (const entries of pending) assert.ok(entries.length >= 3);
  const limited = await list(
    "pending publication limit is applied by actual database",
    1,
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(limited[i], pending[i].slice(0, 1));
  for (const rows of await list("zero publication limit is empty", 0))
    assert.deepEqual(rows, []);
  const entry = pending.map((p) => p[0]);
  const raw = async () => {
    const states = [];
    for (const r of pair) {
      const response = await r.request({
        op: "query-json",
        sql: "SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY commit_id),'[]'::jsonb) result FROM native_history_publications p",
      });
      assert.equal(response.rejected, false, response.diagnostic);
      states.push(response.value);
    }
    return states;
  };
  const mutate = (name, action, entries, expected) =>
    call(name, (i) => ({
      op: "native-history-publication-" + action,
      entry: entries(i),
      at: stamp,
    })).then((results) => {
      assert.deepEqual(results, [expected, expected]);
      return results;
    });
  for (const [field, value] of Object.entries({
    ownerId: otherOwner,
    workerId: "unrelated-worker",
    chatId: "unrelated-chat",
    bindingId: "unrelated-binding",
    commitId: "unrelated-commit",
  })) {
    const before = await raw();
    for (const action of ["ack", "defer"])
      await mutate(
        `${action} fences unrelated ${field}`,
        action,
        (i) => ({ ...entry[i], [field]: value }),
        false,
      );
    assert.deepEqual(
      await raw(),
      before,
      field + " cannot mutate any publication",
    );
  }
  await seed(
    (i) =>
      `UPDATE native_history_publications SET next_attempt_at='2099-01-01T00:00:00Z' WHERE commit_id=${literal(entry[i].commitId)}`,
  );
  const future = await list(
    "future publication cannot be delivered before its actual due clock",
  );
  for (let i = 0; i < 2; i++) assert.deepEqual(future[i], pending[i].slice(1));
  await mutate(
    "defer sets durable due clock and increments attempts",
    "defer",
    (i) => entry[i],
    true,
  );
  await mutate(
    "a repeated defer increments retained attempts again",
    "defer",
    (i) => entry[i],
    true,
  );
  const deferred = await list(
    "deferred publication is independently runnable again",
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(deferred[i][0], { ...entry[i], attempts: 2 });
  const beforeOrphan = await raw();
  // A project's composite owner FK correctly prevents changing just its Chat
  // owner. Exercise a mismatched legacy binding without disabling constraints.
  await seed(
    (i) =>
      `UPDATE native_history_bindings SET owner_id=${literal(otherOwner)} WHERE id=${literal(entry[i].bindingId)}`,
  );
  const orphaned = await list("orphaned owner binding is never published");
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      orphaned[i],
      deferred[i].filter((p) => p.bindingId !== entry[i].bindingId),
    );
  for (const action of ["ack", "defer"])
    await mutate(
      `${action} requires the chat still belongs to the binding owner`,
      action,
      (i) => ({ ...entry[i], ownerId: otherOwner }),
      false,
    );
  assert.deepEqual(
    await raw(),
    beforeOrphan,
    "lost ownership cannot acknowledge or reschedule work",
  );
  await seed(
    (i) =>
      `UPDATE native_history_bindings SET owner_id=${literal(owner)} WHERE id=${literal(entry[i].bindingId)}`,
  );
  await mutate(
    "acknowledge deletes exactly the committed owned publication",
    "ack",
    (i) => entry[i],
    true,
  );
  await mutate(
    "acknowledge replay reports the already absent row",
    "ack",
    (i) => entry[i],
    false,
  );
  await mutate(
    "defer cannot recreate an acknowledged row",
    "defer",
    (i) => entry[i],
    false,
  );
  const remaining = await list(
    "acknowledgment preserves unrelated pending publications",
  );
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(remaining[i], pending[i].slice(1));
    const response = await pair[i].request({
      op: "query-json",
      sql: `SELECT to_jsonb(count(*)) result FROM native_history_receipts WHERE commit_id=${literal(entry[i].commitId)}`,
    });
    assert.equal(response.rejected, false, response.diagnostic);
    assert.equal(
      response.value,
      1,
      "publication acknowledgment never consumes accepted history",
    );
  }
  // Restore a shared static clock before the full relational snapshot, keeping
  // real acknowledgment/attempt state and every unrelated row intact.
  await seed(
    `UPDATE native_history_publications SET next_attempt_at=${literal(stamp)}`,
  );
  await snapshot(
    "publication fencing and acknowledgment preserve canonical history and execution",
  );
  afterReopen.push(async () => {
    // All retained rows now share the exact seed clock. Independently assert
    // each database's commit-ID tiebreak instead of comparing random UUID order
    // between the isolated implementations.
    const reloaded = [];
    for (const r of pair) {
      const response = await r.request({
        op: "native-history-publications",
        owner,
        limit: 64,
      });
      assert.equal(response.rejected, false, response.diagnostic);
      reloaded.push(response.value);
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(
        reloaded[i].some((p) => p.commitId === entry[i].commitId),
        false,
      );
      assert.deepEqual(
        new Set(reloaded[i].map((p) => p.commitId)),
        new Set(remaining[i].map((p) => p.commitId)),
      );
      assert.deepEqual(
        reloaded[i].map((p) => p.commitId),
        reloaded[i].map((p) => p.commitId).sort(),
      );
    }
  });
}
