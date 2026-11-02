import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { stamp } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%task_dispatch_cycles%' AND query ILIKE '%update%' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await sleep(20);
  }
  assert.equal(
    rows.length,
    count,
    "actual concurrent Task lease UPDATE lock waiters",
  );
  return rows;
}
export async function runTaskDispatchLeaseRaces(h, reset, fence) {
  h.report.taskLeaseRaces = [];
  for (const mixed of [false, true])
    for (const reverse of [false, true]) {
      await reset();
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable: h.executable,
          root: path.join(h.root, "task-lease-peer"),
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
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM task_dispatch_cycles WHERE id=${fence.cycleId} FOR UPDATE`;
            locked();
            await gate;
          });
          await Promise.race([
            acquired,
            held.then(() => {
              throw new Error(
                "Task lease blocker ended before acquiring its lock",
              );
            }),
          ]);
          const first = reverse ? "pause-unstarted" : "running",
            second = reverse ? "running" : "pause-unstarted";
          const request = (actor, action) => {
            const value = actor.request({
              op: "native-command-task-lease",
              owner: h.owner,
              action,
              fence,
              affinity: { threadId: "race-paused", turnId: null },
              options: { now: stamp },
            });
            value.catch(() => {});
            pending.push(value);
          };
          request(h.pair[i], first);
          const one = await waiters(observer, 1);
          request(peer, second);
          const both = await waiters(observer, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          assert.equal(
            outcomes.filter((o) => !o.rejected).length,
            1,
            "exactly one competing launch or unstarted pause wins",
          );
          const failure = outcomes.find((o) => o.rejected);
          assert.equal(failure.taskLeaseError, "stale-lease");
          const rows =
            await observer`SELECT state,fencing_token::int,started_at,codex_thread_id FROM task_dispatch_cycles WHERE id=${fence.cycleId}`;
          assert.equal(rows.length, 1);
          const row = rows[0];
          if (row.state === "running") {
            assert.equal(row.fencing_token, 1);
            assert.ok(row.started_at);
            assert.equal(row.codex_thread_id, null);
          } else {
            assert.equal(row.state, "paused");
            assert.equal(row.fencing_token, 2);
            assert.equal(row.started_at, null);
            assert.equal(row.codex_thread_id, "race-paused");
          }
          h.report.taskLeaseRaces.push({
            kind,
            peerKind,
            first,
            second,
            witnesses: { one, both },
            state: row,
            outcomes,
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
