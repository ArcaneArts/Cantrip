import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal, stamp } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
async function waiters(sql, count) {
  let rows = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%users%' AND query ILIKE '%FOR UPDATE%' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await sleep(20);
  }
  assert.equal(
    rows.length,
    count,
    "actual competing Task scheduler owner-lock waiters",
  );
  return rows;
}
export async function runTaskSchedulerRaces(h, setup) {
  h.report.taskSchedulerRaces = [];
  for (const mode of ["claim-claim", "resume-claim", "recover-claim"])
    for (const mixed of [false, true])
      for (const reverse of [false, true]) {
        let expected;
        if (mode === "recover-claim") {
          expected = await setup.goal();
          await h.seed(
            "UPDATE task_dispatch_cycles SET state='failed',lease_owner=NULL,lease_expires_at=NULL",
          );
        } else {
          await setup.clean();
          await setup.enqueue();
          if (mode === "resume-claim") {
            const claimed = await setup.claim();
            await setup.ok(
              "prepare paused cycle for competing resume",
              "pause",
              (i) => ({
                fence: claimed[i].lease,
                affinity: { threadId: "retained-race-thread", turnId: null },
              }),
            );
          }
        }
        await h.seed(
          `UPDATE task_workers SET enabled=false WHERE id='${setup.second}'`,
        );
        await setup.enqueue("scheduler-next", "competing-next");
        for (const [i, kind] of ["node", "rust"].entries()) {
          const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
          const peer = await repositoryFixture({
            kind: peerKind,
            executable: h.executable,
            root: path.join(h.root, "task-scheduler-peer"),
            databaseMode: "postgres",
            databaseUrl: h.urls[i],
          });
          const blocker = postgres(h.urls[i], { max: 1 }),
            observer = postgres(h.urls[i], { max: 1 });
          let release, locked, held;
          const acquired = new Promise((r) => (locked = r)),
            gate = new Promise((r) => (release = r)),
            pending = [];
          try {
            held = blocker.begin(async (sql) => {
              await sql`SELECT id FROM users WHERE id=${h.owner} FOR UPDATE`;
              locked();
              await gate;
            });
            await Promise.race([
              acquired,
              held.then(() => {
                throw new Error(
                  "Task scheduler blocker ended before acquiring its lock",
                );
              }),
            ]);
            function request(actor, index) {
              const special =
                mode === "resume-claim"
                  ? "resume"
                  : mode === "recover-claim"
                    ? "recover"
                    : "claim";
              const action = reverse
                ? index === 0
                  ? "claim"
                  : special
                : index === 0
                  ? special
                  : "claim";
              const promise = actor.request({
                op: "native-command-task-scheduler",
                action,
                owner: h.owner,
                leaseOwner: "race-" + index,
                options: { now: stamp, allowSettled: true },
                resolution: setup.eligible,
                ...(action === "recover" ? { expected: expected[i] } : {}),
              });
              promise.catch(() => {});
              pending.push(promise);
            }
            request(reverse ? peer : h.pair[i], 0);
            const one = await waiters(observer, 1);
            request(reverse ? h.pair[i] : peer, 1);
            const both = await waiters(observer, 2);
            release();
            await held;
            const outcomes = await Promise.all(pending);
            for (const outcome of outcomes)
              assert.equal(outcome.rejected, false, outcome.diagnostic);
            assert.ok(
              outcomes[0].value.value,
              "first admitted owner operation succeeds",
            );
            if (reverse && mode === "recover-claim")
              assert.deepEqual(outcomes[1].value.error, {
                kind: "conflict",
                code: "active-operation",
                message:
                  "The Task Worker has no available capacity. Retry when a running Task finishes.",
              });
            else
              assert.equal(
                outcomes[1].value.value,
                null,
                "capacity prevents the waiting operation",
              );
            assert.deepEqual(
              outcomes[1].value.trace,
              [],
              "capacity rejection never invokes a routing resolver",
            );
            const rows =
              await observer`SELECT id,chat_id,state,selected_task_worker_id,lease_owner,fencing_token::int,attempt_count,codex_thread_id FROM task_dispatch_cycles ORDER BY chat_id,operation_id`;
            const active = rows.filter((r) =>
              ["claimed", "running"].includes(r.state),
            );
            assert.equal(
              active.length,
              1,
              "global Task worker capacity has one admitted operation",
            );
            assert.equal(
              active[0].chat_id,
              reverse && mode !== "claim-claim" ? "scheduler-next" : "task",
            );
            assert.equal(active[0].selected_task_worker_id, setup.worker);
            if (reverse && mode !== "claim-claim") {
              assert.equal(active[0].lease_owner, "race-0");
              assert.equal(active[0].fencing_token, 1);
              assert.equal(active[0].attempt_count, 1);
            } else if (mode === "recover-claim") {
              assert.equal(active[0].lease_owner, "race-0");
              assert.equal(active[0].fencing_token, 2);
              assert.equal(active[0].attempt_count, 1);
              assert.equal(active[0].codex_thread_id, "retained-thread");
            } else if (mode === "resume-claim") {
              assert.equal(active[0].lease_owner, "scheduler-owner");
              assert.equal(active[0].fencing_token, 1);
              assert.equal(active[0].attempt_count, 2);
              assert.equal(active[0].codex_thread_id, "retained-race-thread");
            } else {
              assert.equal(active[0].lease_owner, "race-0");
              assert.equal(active[0].fencing_token, 1);
              assert.equal(active[0].attempt_count, 1);
            }
            h.report.taskSchedulerRaces.push({
              mode,
              kind,
              peerKind,
              reverse,
              witnesses: { one, both },
              outcomes,
              rows,
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
