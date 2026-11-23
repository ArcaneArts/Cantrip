import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

async function waiters(sql, count) {
  let rows = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%users%' AND query ILIKE '%FOR UPDATE%' AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await delay(20);
  }
  assert.equal(
    rows.length,
    count,
    "actual competing Task native-recovery owner locks",
  );
}

export async function runTaskNativeTurnRecoveryRaces(h, clean) {
  h.report.nativeTurnRecoveryRaces = [];
  for (const mixed of [false, true])
    for (const [i, kind] of ["node", "rust"].entries()) {
      const expected = (await clean())[i];
      const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
      const peer = await repositoryFixture({
        kind: peerKind,
        executable: h.executable,
        root: path.join(h.root, `native-recovery-race-${kind}-${peerKind}`),
        databaseMode: "postgres",
        databaseUrl: h.urls[i],
      });
      const blocker = postgres(h.urls[i], { max: 1 }),
        observer = postgres(h.urls[i], { max: 1 });
      let release, acquired, held;
      const gate = new Promise((resolve) => (release = resolve));
      const ready = new Promise((resolve) => (acquired = resolve));
      const pending = [];
      try {
        held = blocker.begin(async (sql) => {
          await sql`SELECT id FROM users WHERE id=${h.owner} FOR UPDATE`;
          acquired();
          await gate;
        });
        await Promise.race([
          ready,
          held.then(() => {
            throw new Error(
              "Native-recovery blocker ended before acquiring its owner lock",
            );
          }),
        ]);
        const observed = {
          threadId: expected.source.nativeExecution.threadId,
          turnId: expected.source.nativeExecution.turnId,
          runtimeGeneration: "91919191-9191-4919-8919-000000000007",
          status: "interrupted",
        };
        const request = (actor) => {
          const operation = actor.request({
            op: "native-command-task",
            owner: h.owner,
            chat: "task",
            action: "fail-native-turn",
            expected,
            observed,
          });
          operation.catch(() => {});
          pending.push(operation);
        };
        request(h.pair[i]);
        const first = await waiters(observer, 1);
        request(peer);
        const both = await waiters(observer, 2);
        release();
        await held;
        const outcomes = await Promise.all(pending);
        for (const outcome of outcomes)
          assert.equal(outcome.rejected, false, outcome.diagnostic);
        assert.deepEqual(
          outcomes.map((outcome) => outcome.value.value),
          [true, false],
        );
        const [row] =
          await observer`SELECT t.state,t.row_version,t.active_operation_id,t.automatic_retry,r.inference_input,c.fencing_token,c.attempt_count,c.state AS dispatch_state,l.state AS lane_state FROM tasks t JOIN task_planning_rounds r ON r.chat_id=t.chat_id JOIN task_dispatch_cycles c ON c.operation_id=r.id JOIN chat_execution_lanes l ON l.id=r.execution_lane_id WHERE t.chat_id='task'`;
        assert.equal(row.state, "failed");
        assert.equal(row.row_version, 3);
        assert.equal(row.active_operation_id, null);
        assert.deepEqual(row.automatic_retry, {
          status: "idle",
          failureKind: "runtime",
          failureKey: `native-terminal:${expected.guard.cycleId}:${expected.guard.fencingToken}`,
          dueAt: null,
          attempts: [],
          claim: null,
        });
        assert.equal(row.dispatch_state, "failed");
        assert.equal(String(row.fencing_token), "8");
        assert.equal(row.attempt_count, 1);
        assert.equal(row.lane_state, "suspended");
        assert.equal(row.inference_input.terminal.ok, false);
        assert.equal(
          row.inference_input.firstDispatchedOperationId,
          expected.source.receipt.operationId,
        );
        h.report.nativeTurnRecoveryRaces.push({
          pair: [kind, peerKind],
          first,
          both,
          outcomes: outcomes.map((outcome) => outcome.value.value),
          rowVersion: row.row_version,
        });
      } finally {
        release();
        await held?.catch(() => {});
        await Promise.allSettled(pending);
        await peer.close();
        await blocker.end({ timeout: 5 });
        await observer.end({ timeout: 5 });
      }
    }
}
