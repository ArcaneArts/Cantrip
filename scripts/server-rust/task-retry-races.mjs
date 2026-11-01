import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
async function waiters(sql, count) {
  const until = Date.now() + 20000;
  let rows = [];
  while (Date.now() < until) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%users%' AND query ILIKE '%FOR UPDATE%' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "actual competing retry owner-lock waiters");
  return rows;
}
export async function runTaskRetryRaces(h, clean) {
  h.report.taskRetryRaces = [];
  for (const mode of ["claim", "note", "finish"])
    for (const mixed of [false, true])
      for (const reverse of [false, true]) {
        await clean();
        for (const [i, kind] of ["node", "rust"].entries()) {
          const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
          const peer = await repositoryFixture({
            kind: peerKind,
            executable: h.executable,
            root: path.join(h.root, "task-retry-peer"),
            databaseMode: "postgres",
            databaseUrl: h.urls[i],
          });
          const blocker = postgres(h.urls[i], { max: 1 }),
            observer = postgres(h.urls[i], { max: 1 });
          let release, locked, held;
          const pending = [];
          const acquired = new Promise((r) => (locked = r)),
            gate = new Promise((r) => (release = r));
          try {
            const record = {
              status: mode === "finish" ? "retrying" : "scheduled",
              failureKind: "runtime",
              failureKey: "seed",
              dueAt: 60000,
              attempts: mode === "finish" ? [60000] : [],
              claim:
                mode === "finish"
                  ? { id: "race-claim", expiresAt: 360000 }
                  : null,
            };
            if (mode !== "note")
              await observer`UPDATE tasks SET automatic_retry=${observer.json(record)} WHERE chat_id='task'`;
            held = blocker.begin(async (sql) => {
              await sql`SELECT id FROM users WHERE id=${h.owner} FOR UPDATE`;
              locked();
              await gate;
            });
            await Promise.race([
              acquired,
              held.then(() => {
                throw new Error(
                  "Retry blocker ended before acquiring owner lock",
                );
              }),
            ]);
            const request = (actor) => {
              const p = actor.request({
                op: "native-command-task-retry",
                owner: h.owner,
                chat: "task",
                action: mode,
                key: "same-failure",
                kind: "timeout",
                claim: "race-claim",
                now: 60000,
              });
              p.catch(() => {});
              pending.push(p);
            };
            request(reverse ? peer : h.pair[i]);
            const first = await waiters(observer, 1);
            request(reverse ? h.pair[i] : peer);
            const both = await waiters(observer, 2);
            release();
            await held;
            const outcomes = await Promise.all(pending);
            for (const outcome of outcomes)
              assert.equal(outcome.rejected, false, outcome.diagnostic);
            const rows =
              await observer`SELECT automatic_retry,row_version,scheduler_revision FROM tasks WHERE chat_id='task'`;
            assert.equal(rows.length, 1);
            assert.equal(rows[0].row_version, 1);
            assert.equal(rows[0].scheduler_revision, 1);
            if (mode === "claim") {
              assert.ok(outcomes[0].value.value.id);
              assert.equal(outcomes[1].value.value, null);
              assert.equal(rows[0].automatic_retry.attempts.length, 1);
              assert.equal(
                rows[0].automatic_retry.claim.id,
                outcomes[0].value.value.id,
              );
            } else {
              assert.deepEqual(
                outcomes.map((o) => o.value.value),
                [true, false],
              );
              assert.equal(
                rows[0].automatic_retry.status,
                mode === "note" ? "scheduled" : "idle",
              );
            }
            h.report.taskRetryRaces.push({
              mode,
              kind,
              peerKind,
              reverse,
              witnesses: { first, both },
              outcomes,
              row: rows[0],
              passed: true,
            });
          } finally {
            release();
            if (held) await held.catch(() => {});
            await Promise.allSettled(pending);
            await peer.close();
            await Promise.all([blocker.end(), observer.end()]);
          }
        }
      }
}
