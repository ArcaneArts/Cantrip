import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { taskStart, taskResult } from "./task-wire-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
async function waiters(sql, count, table) {
  const deadline = Date.now() + 20_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE ${"%" + table + "%"} AND query ILIKE '%FOR UPDATE%' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "actual competing Task row-lock waiters");
  return rows;
}
export async function runTaskRepositoryRaces(h, clean) {
  h.report.taskRepositoryRaces = [];
  const operation = "77777777-7777-4777-8777-000000000201";
  for (const mode of ["distinct-start", "duplicate-start", "complete"])
    for (const mixed of [false, true])
      for (const reverse of [false, true]) {
        await clean(mode !== "complete");
        for (const [i, kind] of ["node", "rust"].entries()) {
          const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
          const peer = await repositoryFixture({
            kind: peerKind,
            executable: h.executable,
            root: path.join(h.root, "task-repository-peer"),
            databaseMode: "postgres",
            databaseUrl: h.urls[i],
          });
          const blocker = postgres(h.urls[i], { max: 1 }),
            observer = postgres(h.urls[i], { max: 1 });
          const start = taskStart(
            mode === "complete" ? "direct" : "initial-plan",
            "task",
            1,
            1,
            operation,
          );
          let release, locked, held;
          const pending = [],
            acquired = new Promise((r) => (locked = r)),
            gate = new Promise((r) => (release = r));
          try {
            if (mode === "complete") {
              const admitted = await h.pair[i].request({
                op: "native-command-task",
                owner: h.owner,
                chat: "task",
                action: "begin",
                input: start,
              });
              assert.equal(admitted.rejected, false, admitted.diagnostic);
              assert.equal(admitted.value.value.idempotent, false);
            }
            held = blocker.begin(async (sql) => {
              if (mode === "complete")
                await sql`SELECT id FROM task_planning_rounds WHERE id=${operation} FOR UPDATE`;
              else
                await sql`SELECT chat_id FROM tasks WHERE chat_id='task' FOR UPDATE`;
              locked();
              await gate;
            });
            await Promise.race([
              acquired,
              held.then(() => {
                throw new Error(
                  "Task blocker ended before acquiring its row lock",
                );
              }),
            ]);
            function request(actor, index) {
              const input =
                mode === "complete"
                  ? taskResult(start)
                  : structuredClone(start);
              if (mode === "distinct-start" && index === 1)
                input.operation.operationId =
                  "77777777-7777-4777-8777-000000000202";
              if (mode === "complete" && index === 1)
                input.protectedResult.envelope.nonce = "BBBBBBBBBBBBBBBB";
              const promise = actor.request({
                op: "native-command-task",
                owner: h.owner,
                chat: "task",
                operation,
                action: mode === "complete" ? "complete" : "begin",
                input,
                turn: "race-turn-" + index,
              });
              promise.catch(() => {});
              pending.push(promise);
            }
            request(reverse ? peer : h.pair[i], 0);
            const first = await waiters(
              observer,
              1,
              mode === "complete" ? "task_planning_rounds" : "tasks",
            );
            request(reverse ? h.pair[i] : peer, 1);
            const both = await waiters(
              observer,
              2,
              mode === "complete" ? "task_planning_rounds" : "tasks",
            );
            release();
            await held;
            const outcomes = await Promise.all(pending);
            for (const outcome of outcomes)
              assert.equal(outcome.rejected, false, outcome.diagnostic);
            const rows =
              await observer`SELECT t.state,t.row_version,t.active_operation_id,r.relay_result,r.turn_id FROM tasks t JOIN task_planning_rounds r ON r.chat_id=t.chat_id WHERE t.chat_id='task' ORDER BY r.ordinal`;
            assert.equal(rows.length, 1, "exactly one durable Task operation");
            if (mode === "complete") {
              for (const outcome of outcomes) {
                assert.equal(outcome.value.value.task.rowVersion, 3);
                assert.equal(outcome.value.value.round.turnId, "race-turn-0");
              }
              assert.equal(rows[0].row_version, 3);
              assert.equal(rows[0].state, "complete");
              assert.equal(
                rows[0].relay_result.protectedResult.envelope.nonce,
                taskResult(start).protectedResult.envelope.nonce,
              );
            } else {
              assert.equal(
                outcomes.filter((o) => Object.hasOwn(o.value, "value")).length,
                1,
              );
              assert.deepEqual(
                outcomes.find((o) => o.value.error).value.error,
                {
                  code: "operation-active",
                  stateTransition: null,
                  message: "This Task already has an active operation.",
                },
              );
              assert.equal(rows[0].row_version, 2);
              assert.equal(rows[0].state, "planning");
              assert.equal(rows[0].active_operation_id, operation);
            }
            h.report.taskRepositoryRaces.push({
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
