import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal } from "./project-target-state.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { nativeQueueHttpContent } from "./native-queue-http-content.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function nativeQueueTransactionCase({ h, client, result }) {
  const content = nativeQueueHttpContent(h, result),
    session = h.prepared[chat].session;
  const query = async (sql) => (await h.fixture.sql([], [sql]))[0];
  const call = async (name, action, input, status = 200) => {
    const value = await h.visit(
      name,
      "POST",
      "/api/internal/native-queue/" + action,
      {
        client: "worker",
        headers: { authorization: "Bearer " + h.credential },
        json: input,
        status,
      },
    );
    await content.prove(value);
    return value;
  };
  const drained = async (revision) => {
    const deadline = Date.now() + 15000;
    let state;
    do {
      state = await query(
        `SELECT jsonb_build_object('revision',revision,'notified',notified_revision)::text result FROM managed_queue_states WHERE chat_id=${literal(chat)}`,
      );
      if (state.notified === revision) break;
      await sleep(20);
    } while (Date.now() < deadline);
    assert.deepEqual(state, { revision, notified: revision });
    await h.live.ping("queue-transaction-drained-" + revision);
  };
  const snapshot = () =>
    query(`SELECT jsonb_build_object(
    'prompts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM queued_prompts p WHERE chat_id=${literal(chat)}),
    'imports',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM managed_queue_imports i WHERE chat_id=${literal(chat)}),
    'commands',(SELECT jsonb_agg(to_jsonb(n) ORDER BY operation_id) FROM native_commands n WHERE chat_id=${literal(chat)} AND (operation_id LIKE 'queue-transaction-%' OR operation_id LIKE 'queue-import:%')),
    'revision',(SELECT revision FROM managed_queue_states WHERE chat_id=${literal(chat)}))::text result`);
  const events = () =>
    h.live.history.filter(
      (v) => v.type === "event" && v.resource === "chat-queue",
    );
  const firstPrompt = await content.prompt({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
    key: "queue-transaction-first",
    text: "Private concurrent queue input 🌻",
  });
  const admission = command({
    workerId: worker,
    operationId: "queue-transaction-concurrent",
    session,
    method: "thread/queue/add",
  });
  const input = {
    admission,
    expectedRevision: 0,
    mutation: { kind: "add", prompt: firstPrompt, attachments: [] },
  };
  assert.equal((await client.read({ session })).revision, 0);
  await drained(0);
  const beforeConcurrentEvents = events().length;
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => client.mutate(input)),
  );
  for (const [i, value] of concurrent.entries()) {
    assert.deepEqual(
      value,
      concurrent[0],
      "concurrent identical requests return the exact stored receipt and snapshot",
    );
    await content.sdk(
      "concurrent worker SDK queue mutation " + i,
      async () => value,
    );
  }
  assert.equal(concurrent[0].receipt.status, "applied");
  assert.equal(concurrent[0].revision, 1);
  assert.equal(concurrent[0].items.length, 1);
  await drained(1);
  assert.equal(
    events().length - beforeConcurrentEvents,
    5,
    "four route invalidations and one durable revision notice",
  );
  const committed = await snapshot();
  assert.equal(committed.prompts.length, 1);
  assert.equal(committed.commands.length, 1);
  result.proofs.push(
    "four concurrent identical SDK mutations commit one encrypted prompt, one command and one revision with exact immutable replay",
  );

  const secondPrompt = await content.prompt({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
    messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4",
    key: "queue-transaction-second",
    text: "Private rollback queue input 🌾",
  });
  const failedInput = {
    admission: command({
      ...admission,
      operationId: "queue-transaction-fault",
    }),
    expectedRevision: 1,
    mutation: { kind: "add", prompt: secondPrompt, attachments: [] },
  };
  await h.fixture.sql([
    "CREATE FUNCTION fixture_queue_transaction_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='queue-transaction-fault' AND NEW.status='applied' THEN RAISE EXCEPTION 'Controlled queue transaction failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fixture_queue_transaction_fault BEFORE UPDATE ON native_commands FOR EACH ROW EXECUTE FUNCTION fixture_queue_transaction_fault()",
  ]);
  const beforeFailure = await snapshot(),
    beforeFailureEvents = events();
  const failed = await call(
    "queue effect failure rolls back admission and encrypted prompt",
    "mutate",
    failedInput,
    500,
  );
  assert.equal(failed.error, "Internal server error.");
  assert.equal(typeof failed.requestId, "string");
  assert.equal(
    JSON.stringify(failed).includes("Controlled queue transaction failure"),
    false,
  );
  assert.deepEqual(
    await snapshot(),
    beforeFailure,
    "failure after prompt insertion and revision bump rolls back every queue effect",
  );
  await h.live.ping("queue-failed-mutation");
  assert.deepEqual(
    events(),
    beforeFailureEvents,
    "rolled-back mutations publish nothing",
  );
  await h.fixture.sql([
    "DROP TRIGGER fixture_queue_transaction_fault ON native_commands",
    "DROP FUNCTION fixture_queue_transaction_fault()",
  ]);
  const retried = await call(
    "same operation succeeds after real SQL failure",
    "mutate",
    failedInput,
  );
  assert.equal(retried.receipt.status, "applied");
  assert.equal(retried.revision, 2);
  await drained(2);
  result.proofs.push(
    "SQL failure after prompt insertion and revision bump rolls back admission, ciphertext and revision, publishes nothing and permits exact-operation retry",
  );

  const importedPrompt = await content.prompt({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
    messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6",
    key: "queue-transaction-import",
    text: "Private transactional native import 🌿",
  });
  const importInput = {
    workerId: worker,
    session,
    runnerGeneration: "transaction-runner",
    items: [
      {
        nativeItemId: "transaction-native-item",
        sourceDigest: "d".repeat(64),
        protectedSource: importedPrompt.protectedNativeInput,
        prompt: importedPrompt,
        attachments: [],
      },
    ],
  };
  await h.fixture.sql([
    "CREATE FUNCTION fixture_queue_import_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled import transaction failure'; END $$",
    "CREATE TRIGGER fixture_queue_import_fault BEFORE INSERT ON managed_queue_imports FOR EACH ROW EXECUTE FUNCTION fixture_queue_import_fault()",
  ]);
  const beforeImport = await snapshot();
  const rejectedImport = await call(
    "import SQL failure rolls back nested mutation",
    "import",
    importInput,
    500,
  );
  assert.equal(rejectedImport.error, "Internal server error.");
  assert.deepEqual(await snapshot(), beforeImport);
  await h.fixture.sql([
    "DROP TRIGGER fixture_queue_import_fault ON managed_queue_imports",
    "DROP FUNCTION fixture_queue_import_fault()",
  ]);
  const imported = await call(
    "native import retries without partial admission",
    "import",
    importInput,
  );
  const importId = hash([
    hash([
      h.owner,
      worker,
      { ...session, runtimeGeneration: null, connectionId: null },
      importInput.items[0].nativeItemId,
    ]),
    importInput.items[0].sourceDigest,
  ]);
  assert.equal(imported.imports[0].importId, importId);
  content.identity(importId, "<transactional import>");
  assert.equal(imported.revision, 3);
  assert.equal(imported.pendingImports.length, 1);
  await drained(3);
  const ack = {
    workerId: worker,
    session,
    runnerGeneration: importInput.runnerGeneration,
    importId,
    sourceDigest: importInput.items[0].sourceDigest,
    receipt: { deleted: true, conflict: false },
  };
  await h.fixture.sql([
    "CREATE FUNCTION fixture_queue_ack_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state='importing' AND NEW.state='pending' THEN RAISE EXCEPTION 'Controlled import acknowledgment failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fixture_queue_ack_fault BEFORE UPDATE ON queued_prompts FOR EACH ROW EXECUTE FUNCTION fixture_queue_ack_fault()",
  ]);
  const beforeAck = await snapshot(),
    beforeAckEvents = events();
  const failedAck = await call(
    "ack SQL failure retains pending encrypted import",
    "import-ack",
    ack,
    500,
  );
  assert.equal(failedAck.error, "Internal server error.");
  assert.deepEqual(await snapshot(), beforeAck);
  await h.live.ping("queue-failed-ack");
  assert.deepEqual(events(), beforeAckEvents);
  await h.fixture.sql([
    "DROP TRIGGER fixture_queue_ack_fault ON queued_prompts",
    "DROP FUNCTION fixture_queue_ack_fault()",
  ]);
  const acknowledged = await content.sdk(
    "worker retries import acknowledgment after SQL rollback",
    () => client.acknowledgeImport(ack),
  );
  assert.equal(acknowledged.revision, 4);
  assert.deepEqual(acknowledged.pendingImports, []);
  assert.equal(acknowledged.items.length, 3);
  assert.ok(acknowledged.items.every((v) => v.frozen && v.state === "pending"));
  await drained(4);
  result.proofs.push(
    "native import and deletion acknowledgment SQL failures roll back their nested state transitions and retry without duplicates",
  );

  const beforeRestart = await snapshot(),
    beforeLookup = await client.lookup({ admission });
  const port = Number(new URL(h.fixture.server.origin).port),
    connections = h.connectionCount();
  await h.live.close();
  await h.fixture.close();
  await h.fixture.start({ port });
  const deadline = Date.now() + 15000;
  while (h.connectionCount() <= connections && Date.now() < deadline)
    await sleep(20);
  assert.ok(
    h.connectionCount() > connections,
    "actual existing worker reconnects after server restart",
  );
  const restartedLive = await new LiveProbe(h.fixture).open();
  try {
    await restartedLive.initialized();
    await restartedLive.subscribed("restarted-transaction-queue", [
      { kind: "chat", chatId: chat },
    ]);
    assert.deepEqual(
      await query(
        `SELECT jsonb_build_object('status',c.status,'lane',(SELECT state FROM chat_execution_lanes WHERE id=${literal(h.prepared[chat].executionLaneId)}))::text result FROM chats c WHERE c.id=${literal(chat)}`,
      ),
      { status: "failed", lane: "suspended" },
      "real startup recovers the interrupted prepared turn before queue dispatch",
    );
    assert.deepEqual(
      await content.sdk(
        "worker SDK reads identical encrypted queue after server restart",
        () => client.read({ session }),
      ),
      acknowledged,
    );
    assert.deepEqual(
      await content.sdk(
        "worker SDK retains immutable operation after server restart",
        () => client.lookup({ admission }),
      ),
      beforeLookup,
    );
    assert.deepEqual(
      await snapshot(),
      beforeRestart,
      "restart preserves all queued ciphertext, import rows, immutable commands and revision",
    );
    assert.deepEqual(
      (await client.read({ session })).claims,
      [],
      "frozen inputs never dispatch during restart recovery",
    );
    result.proofs.push(
      "actual server restart and existing-worker reconnect retain ciphertext, import receipts, immutable command results and revision without dispatching frozen input",
    );
    const startOperation = "queue-transaction-start";
    const startInput = {
      admission: command({
        ...admission,
        operationId: startOperation,
        method: "thread/queue/start",
      }),
      expectedRevision: 4,
      mutation: { kind: "start", id: firstPrompt.id },
    };
    const started = await content.sdk(
      "worker explicitly starts its frozen queue item",
      () => client.mutate(startInput),
    );
    const claimId =
      "queue:" + createHash("sha256").update(startOperation).digest("hex");
    assert.equal(started.receipt.status, "applied");
    assert.equal(started.revision, 5);
    assert.equal(started.claim.id, claimId);
    assert.equal(started.claim.promptId, firstPrompt.id);
    assert.equal(started.claim.promptRevision, 0);
    assert.equal(started.claim.requestOperationId, startOperation);
    assert.equal(started.claim.status, "claimed");
    content.identity(claimId, "<explicit start claim>");
    const retained = await query(
      `SELECT jsonb_build_object('claimId',claim_id,'promptId',prompt_id,'promptRevision',prompt_revision,'protectedInput',protected_input)::text result FROM managed_queue_input_snapshots WHERE claim_id=${literal(claimId)}`,
    );
    assert.equal(retained.claimId, claimId);
    assert.equal(retained.promptId, firstPrompt.id);
    assert.equal(retained.promptRevision, 0);
    await content.prove(retained.protectedInput);
    // This fixture has no routable model for a real turn. The production
    // dispatch failure releases the claim and increments the queue revision;
    // replay retains the immutable receipt while reading that live state.
    let released;
    const releaseDeadline = Date.now() + 15000;
    do {
      released = await query(
        `SELECT jsonb_build_object('status',c.status,'state',p.state,'revision',s.revision)::text result FROM managed_queue_claims c JOIN queued_prompts p ON p.id=c.prompt_id JOIN managed_queue_states s ON s.chat_id=c.chat_id WHERE c.id=${literal(claimId)}`,
      );
      if (released.status === "rejected") break;
      await sleep(20);
    } while (Date.now() < releaseDeadline);
    assert.deepEqual(released, {
      status: "rejected",
      state: "pending",
      revision: 6,
    });
    const replay = await content.sdk(
      "worker replays explicit queue start without a second claim",
      () => client.mutate({ ...startInput, expectedRevision: 999 }),
    );
    assert.deepEqual(replay.receipt, started.receipt);
    assert.equal(replay.revision, 6);
    assert.equal(replay.claim.id, claimId);
    assert.equal(replay.claim.status, "rejected");
    assert.equal(
      await query(
        `SELECT count(*)::text result FROM managed_queue_claims WHERE chat_id=${literal(chat)}`,
      ),
      1,
    );
    result.proofs.push(
      "explicit frozen-item start retains a deterministic claim and decryptable input; production dispatch failure releases it, and replay retains its receipt with current state without creating a second claim",
    );
  } finally {
    await restartedLive.close();
  }
  content.finish();
}
