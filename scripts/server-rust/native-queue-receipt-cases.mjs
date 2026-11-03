import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal, label } from "./project-target-state.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";
import { receiptReadLock } from "./native-queue-receipt-lock.mjs";

async function eventually(read, predicate, message) {
  const end = Date.now() + 15000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(20);
  } while (Date.now() < end);
  assert.ok(predicate(value), message + ": " + JSON.stringify(value));
}

export async function nativeQueueReceiptCases({
  h,
  client,
  result,
  scenario,
  databaseUrl,
}) {
  const content = nativeQueueHttpContent(h, result),
    session = h.prepared[chat].session;
  const prompt = await content.prompt({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    key: "receipt-http-prompt",
    text: "Private receipt queue input 🌙",
  });
  const admission = command({
    workerId: worker,
    operationId: "receipt-http-add",
    method: "thread/queue/add",
    session,
  });
  const added = await content.sdk(
    "worker SDK prepares receipt queue input",
    () =>
      client.mutate({
        admission,
        expectedRevision: 0,
        mutation: { kind: "add", prompt, attachments: [] },
      }),
  );
  assert.equal(added.receipt.status, "applied");
  const prepared = h.prepared[chat],
    claimId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const bound = scenario === "settlement";
  await h.fixture.sql([
    `INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,status,operation_id,operation_generation) VALUES(${literal(claimId)},${literal(chat)},${literal(prompt.id)},0,${literal(bound ? "dispatched" : "claimed")},${bound ? literal(prepared.operationId) : "NULL"},${bound ? literal(prepared.operationGeneration) : "NULL"})`,
    "CREATE TABLE fixture_queue_receipt_reads(n integer NOT NULL)",
    "INSERT INTO fixture_queue_receipt_reads VALUES(0)",
    "CREATE FUNCTION fixture_count_queue_receipt_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE fixture_queue_receipt_reads SET n=n+1; RETURN NEW; END $$",
    "CREATE TRIGGER fixture_count_queue_receipt_read BEFORE INSERT ON managed_queue_states FOR EACH ROW EXECUTE FUNCTION fixture_count_queue_receipt_read()",
  ]);
  const reads = async () =>
    (
      await h.fixture.sql(
        [],
        ["SELECT n::text result FROM fixture_queue_receipt_reads"],
      )
    )[0];
  const snapshot = async () =>
    (
      await h.fixture.sql(
        [],
        [
          `SELECT jsonb_build_object('claim',to_jsonb(c),'prompt',to_jsonb(p))::text result FROM managed_queue_claims c JOIN queued_prompts p ON p.id=c.prompt_id WHERE c.id=${literal(claimId)}`,
        ],
      )
    )[0];
  const auth = {
    client: "worker",
    headers: { authorization: "Bearer " + h.credential },
  };
  const input = { workerId: worker, session, claimId };
  result.scenario = scenario;
  if (scenario === "sql-error") {
    await h.fixture.sql([
      "CREATE OR REPLACE FUNCTION fixture_count_queue_receipt_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_RECEIPT_SQL_FAILURE'; END $$",
    ]);
    const body = await h.visit(
      "receipt SQL failure uses fixed pending error",
      "POST",
      "/api/internal/native-queue/start-receipt",
      { ...auth, json: input, status: 409 },
    );
    assert.deepEqual(body, { code: "queue-receipt-pending" });
    assert.equal(
      JSON.stringify(h.diagnostics()).includes("PRIVATE_RECEIPT_SQL_FAILURE"),
      false,
    );
    result.proofs.push(
      "SQL read failure retains fixed pending response and redaction",
    );
  } else if (scenario === "timeout") {
    const before = await snapshot(),
      started = Date.now();
    const body = await h.visit(
      "real pending receipt deadline",
      "POST",
      "/api/internal/native-queue/start-receipt",
      { ...auth, json: input, timeoutMs: 100000, status: 409 },
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(body, { code: "queue-receipt-pending" });
    assert.ok(
      elapsed >= 89000 && elapsed < 100000,
      "actual 90-second server deadline: " + elapsed,
    );
    const finished = await reads();
    assert.ok(
      finished >= 4,
      "real durable reads continued while the receipt was pending",
    );
    await sleep(1700);
    assert.equal(
      await reads(),
      finished,
      "deadline releases the receipt subscription and read loop",
    );
    assert.deepEqual(
      await snapshot(),
      before,
      "timeout cannot mutate the pending claim or encrypted input",
    );
    result.elapsedMilliseconds = elapsed;
    result.rawReads = { finished };
    result.proofs.push(
      "actual 90-second deadline stops durable polling without changing queued work",
    );
  } else if (scenario === "inflight-disconnect") {
    const before = await snapshot(),
      blocker = await receiptReadLock(databaseUrl),
      controller = new AbortController();
    const pending = client.startReceipt(
      { session, claimId },
      controller.signal,
    );
    pending.catch(() => {});
    try {
      const waiting = await blocker.waiting();
      controller.abort();
      await assert.rejects(
        pending,
        (error) => error.code === "queue-operation-uncertain",
      );
      const retained = await blocker.waiters();
      assert.ok(
        retained.some((v) => v.pid === waiting[0].pid),
        "in-flight read remains owned after the view closes",
      );
      await blocker.release();
      const committed = await eventually(
        reads,
        (n) => n >= 2,
        "in-flight read completes after the real lock release",
      );
      await sleep(1700);
      assert.equal(
        await reads(),
        committed,
        "owned completed read does not leave a disconnected polling view",
      );
      assert.deepEqual(await snapshot(), before);
      result.rawReads = { committed, waiting, retained };
      result.proofs.push(
        "caller disconnect retains the actual locked SQL read until completion and then releases the view",
      );
    } finally {
      controller.abort();
      await blocker.close();
      await pending.catch(() => {});
    }
  } else if (scenario === "settlement" || scenario === "disconnect") {
    const controller = new AbortController();
    let done = false;
    const pending = client
      .startReceipt({ session, claimId }, controller.signal)
      .finally(() => {
        done = true;
      });
    pending.catch(() => {});
    try {
      const first = await eventually(
        reads,
        (n) => n >= 2,
        "actual receipt authority read committed",
      );
      assert.equal(done, false, "receipt really waits for durable settlement");
      const health = await fetch(h.fixture.server.origin + "/healthz");
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, "alive");
      if (scenario === "settlement") {
        const protectedResult = label("chat").protectedLabel.envelope;
        const settled = await h.visit(
          "settle actual prepared native command",
          "POST",
          "/api/internal/native-commands/receipt",
          {
            ...auth,
            json: {
              workerId: worker,
              operationId: prepared.operationId,
              operationGeneration: prepared.operationGeneration,
              status: "applied",
              resultDigest: "c".repeat(64),
              protectedResult,
              rejectionCode: null,
            },
          },
        );
        assert.equal(settled.receipt.status, "applied");
        const received = await content.sdk(
          "worker SDK receives settled queue start receipt",
          () => pending,
        );
        assert.deepEqual(received.protectedResult, protectedResult);
        assert.equal(received.resultDigest, "c".repeat(64));
        assert.equal(received.claim.id, claimId);
        assert.equal(received.receipt.operationId, prepared.operationId);
        assert.deepEqual(
          await content.sdk("worker SDK replays settled receipt", () =>
            client.startReceipt({ session, claimId }),
          ),
          received,
        );
        result.proofs.push(
          "pending actual HTTP receipt resolves to the same durable protected result and replays exactly",
        );
      } else {
        const before = await snapshot();
        controller.abort(new Error("Disposable receipt view closed"));
        await assert.rejects(
          pending,
          (error) => error.code === "queue-operation-uncertain",
        );
        await sleep(100);
        const stopped = await reads();
        await sleep(1700);
        assert.equal(
          await reads(),
          stopped,
          "disconnected view stops durable receipt polling",
        );
        assert.deepEqual(
          await snapshot(),
          before,
          "view disconnect retains the claim and encrypted input",
        );
        result.proofs.push(
          "disconnect stops the waiting view without changing pending durable work",
        );
      }
      result.rawReads = { first, finished: await reads() };
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  } else {
    throw new Error("Unknown native queue receipt scenario: " + scenario);
  }
  content.finish();
}
