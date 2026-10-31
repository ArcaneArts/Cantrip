// Actual PostgreSQL locks force same/mixed writers to overlap before commit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
import { nativeHistoryPayloadDigest } from "../../cantrip_server/src/db/repository/native-history-digest.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 12000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND (query ILIKE '%chats%' OR query ILIKE '%pg_advisory_xact_lock%')`;
    if (rows.length === count) return rows;
    await delay(20);
  }
  assert.equal(
    rows.length,
    count,
    "history writers contend on actual SQL locks",
  );
  return rows;
}
export async function runHistoryRaces(h) {
  const {
    pair,
    urls,
    root,
    executable,
    owner,
    binding,
    request,
    roots,
    call,
    register,
    normalize,
    snapshot,
    report,
  } = h;
  for (const mixed of [false, true])
    for (const scenario of [
      "replay",
      "receipt-conflict",
      "canonical-cas",
      "rejection-replay",
      "stream-conflict",
    ]) {
      const threadId = `history-race-${mixed}-${scenario}`;
      const bindings = await binding(
        "open historical binding for competing " + threadId,
        (i) =>
          request(threadId, { kind: "child", parentBindingId: roots[i].id }),
      );
      const identity = {
        threadId,
        turnId: "race-turn",
        itemId: "race-item",
        component: "user",
        identityKind: "canonical",
      };
      const mappings = await call(
        "reserve actual canonical input for " + threadId,
        (i) => ({
          op: "native-history-resolve",
          input: {
            workerId: "alpha",
            chatId: "chat",
            bindingId: bindings[i].id,
            items: [{ identity, association: { kind: "native" } }],
          },
        }),
      );
      const streamId = randomUUID(),
        otherStream = randomUUID(),
        recordId = randomUUID(),
        secondRecord = randomUUID();
      const input = (i) => ({
        workerId: "alpha",
        chatId: "chat",
        bindingId: bindings[i].id,
        streamId,
        sequence: 1,
        recordId,
        digest: "a".repeat(64),
        previousDigest: null,
        batch: {
          items: [
            {
              identity,
              revision: 1,
              expectedRevision: 0,
              state: "completed",
              order: { turn: 0, item: 0, component: 0 },
              message: {
                ...retainedPrompt().pendingMessage,
                id: mappings[i][0].messageId,
                idempotencyKey: mappings[i][0].idempotencyKey,
              },
              attachments: [],
            },
          ],
          turns: [],
        },
      });
      const stale = (i) => {
        const first = input(i);
        return {
          ...first,
          sequence: 2,
          recordId: secondRecord,
          previousDigest: first.digest,
          digest: "b".repeat(64),
          batch: {
            ...first.batch,
            items: [{ ...first.batch.items[0], revision: 2 }],
          },
        };
      };
      if (scenario === "rejection-replay")
        await call(
          "commit original revision before concurrent rejection " + threadId,
          (i) => ({ op: "native-history-ingest", input: input(i) }),
        );
      const compared = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, threadId + "-peer-" + i),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        let held, release;
        const proof = {
          name: "canonical history " + scenario,
          writers: [kind, peerKind],
          mixed,
          phase: "starting",
        };
        report.races.push(proof);
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            const rows =
              await sql`SELECT id FROM chats WHERE id='chat' FOR UPDATE`;
            assert.equal(rows.length, 1);
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("History blocker ended before contention");
            }),
          ]);
          const enqueue = (repository, second) => {
            let payload = scenario === "rejection-replay" ? stale(i) : input(i);
            if (second && scenario === "receipt-conflict")
              payload = { ...payload, batch: { items: [], turns: [] } };
            if (second && scenario === "canonical-cas") payload = stale(i);
            if (second && scenario === "stream-conflict")
              payload = { ...payload, streamId: otherStream };
            register(
              i,
              nativeHistoryPayloadDigest({
                batch: payload.batch,
                previousDigest: payload.previousDigest,
              }),
              "batch-payload",
            );
            for (const item of payload.batch.items)
              register(i, nativeHistoryPayloadDigest(item), "item-payload");
            const future = repository.request({
              op: "native-history-ingest",
              owner,
              input: payload,
            });
            future.catch(() => {});
            pending.push(future);
          };
          enqueue(pair[i], false);
          proof.firstWaiter = await waiters(observer, 1);
          enqueue(peer, true);
          proof.bothWaiters = await waiters(observer, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          const codes =
            scenario === "rejection-replay"
              ? ["item-revision-conflict", "item-revision-conflict"]
              : [
                  null,
                  {
                    replay: null,
                    "receipt-conflict": "batch-receipt-conflict",
                    "canonical-cas": "item-revision-conflict",
                    "stream-conflict": "stream-recovery-required",
                  }[scenario],
                ];
          for (let n = 0; n < 2; n++) {
            const outcome = outcomes[n];
            assert.equal(
              outcome.rejected,
              codes[n] !== null,
              outcome.diagnostic,
            );
            if (codes[n]) {
              assert.equal(outcome.historyError, codes[n]);
              assert.equal(outcome.historyStatus, 409);
              assert.equal(
                outcome.diagnostic,
                `Native history request failed: ${codes[n]}.`,
              );
              if (outcome.rejection)
                register(i, outcome.rejection.rejectionId, "rejection");
            } else register(i, outcome.value.commitId, "commit");
          }
          if (scenario === "replay")
            assert.deepEqual(outcomes[1].value, outcomes[0].value);
          if (scenario === "rejection-replay")
            assert.deepEqual(outcomes[1].rejection, outcomes[0].rejection);
          compared.push(
            outcomes.map(
              (o) =>
                o.value ??
                o.rejection ?? {
                  code: o.historyError,
                  status: o.historyStatus,
                },
            ),
          );
          proof.outcomes = compared.at(-1);
          proof.phase = "complete";
          proof.passed = true;
        } finally {
          release?.();
          await held?.catch(() => {});
          await Promise.allSettled(pending);
          await peer.close();
          await blocker.end({ timeout: 5 });
          await observer.end({ timeout: 5 });
        }
      }
      assert.deepEqual(
        normalize(compared[1], 1),
        normalize(compared[0], 0),
        threadId + " concurrent durable outcomes",
      );
      const states = await snapshot(
        threadId + " actual concurrent commits and permanent decisions",
      );
      for (let i = 0; i < 2; i++) {
        const state = states[i];
        assert.equal(
          state.items.filter(
            (item) => item.thread_id === threadId && item.revision === 1,
          ).length,
          1,
        );
        assert.equal(
          state.streams.filter(
            (stream) =>
              stream.id === streamId && stream.acknowledged_sequence === 1,
          ).length,
          1,
        );
        assert.equal(
          state.receipts.filter((receipt) => receipt.stream_id === streamId)
            .length,
          1,
        );
        assert.equal(
          (state.rejections ?? []).filter(
            (rejection) => rejection.decision.streamId === streamId,
          ).length,
          ["canonical-cas", "rejection-replay"].includes(scenario) ? 1 : 0,
        );
        assert.equal(
          state.messages.filter(
            (message) => message.id === normalize(mappings[i][0].messageId, i),
          ).length,
          1,
        );
      }
    }
}
