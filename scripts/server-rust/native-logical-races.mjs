// Separate processes contend on a real PostgreSQL project lock. Observations
// prove both requests reached the lock before the transaction is released.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal, stamp } from "./project-target-state.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count, entry) {
  const deadline = Date.now() + 20000;
  let rows = [],
    previous;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    const state = JSON.stringify(rows);
    if (state !== previous) {
      entry.observations.push({ count, at: Date.now(), rows });
      previous = state;
    }
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "logical SQL lock waiter count");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "logical requests wait on actual locks",
  );
  return rows;
}
export async function runLogicalRaces({
  pair,
  urls,
  root,
  executable,
  owner,
  reset,
  seed,
  observe,
  snapshot,
  report,
  register,
  normalized,
}) {
  report.logicalRaces = [];
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  for (const mixed of [false, true])
    for (const scenario of ["replay", "competing-child", "finish"]) {
      await reset();
      await seed(
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('logical-race-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
      );
      const admitted = await observe(
        "logical race root " + scenario,
        command({ operationId: "logical-race-root", session }),
      );
      await observe(
        "logical race dispatch " + scenario,
        (i) => ({
          workerId: "alpha",
          operationId: "logical-race-root",
          operationGeneration: admitted[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "logical-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        const entry = {
          kind,
          peerKind,
          mixed,
          scenario,
          phase: "starting",
          observations: [],
        };
        report.logicalRaces.push(entry);
        let held, release;
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Logical lock ended before contention");
            }),
          ]);
          const input = {
            workerId: "alpha",
            rootOperationId: "logical-race-root",
            previousOperationId: "logical-race-root",
            previousOperationGeneration:
              admitted[i].receipt.operationGeneration,
            operationId: "logical-race-next",
            payloadDigest: "b".repeat(64),
            protectedPayload: command().protectedPayload,
            session,
            reason: "capacity",
            failure: {
              kind: "native-terminal",
              nativeTurnId: "logical-race-turn",
              runtimeGeneration: "runtime",
            },
          };
          const request =
            scenario === "finish"
              ? {
                  op: "native-command-logical-finish",
                  owner,
                  worker: "alpha",
                  operation: "logical-race-root",
                  generation: admitted[i].receipt.operationGeneration,
                  status: "idle",
                }
              : { op: "native-command-logical-continue", owner, input };
          const enqueue = (p) => {
            p.catch(() => {});
            pending.push(p);
          };
          enqueue(pair[i].request(request));
          entry.phase = "first-wait";
          entry.first = await waiters(observer, 1, entry);
          const second = structuredClone(request);
          if (scenario === "competing-child")
            second.input.operationId = "logical-race-competing";
          enqueue(peer.request(second));
          entry.phase = "both-wait";
          entry.both = await waiters(observer, 2, entry);
          release();
          await held;
          entry.phase = "settling";
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
          assert.equal(
            outcomes[1].rejected,
            scenario === "competing-child",
            outcomes[1].diagnostic,
          );
          if (scenario === "competing-child")
            assert.equal(outcomes[1].commandError, "stale-continuation");
          else if (scenario === "finish") {
            assert.equal(outcomes[0].value, true);
            assert.equal(outcomes[1].value, false);
          } else {
            assert.equal(outcomes[0].value.replayed, undefined);
            assert.equal(outcomes[1].value.replayed, true);
          }
          for (const result of outcomes) {
            const receipt = result.value?.receipt;
            if (receipt) {
              register(receipt.operationGeneration, "operation", i);
              register(receipt.activationGeneration, "activation", i);
              register(receipt.executionLaneId, "lane", i);
            }
          }
          results.push(
            outcomes.map((r) => ({
              rejected: r.rejected,
              code: r.commandError,
              value: r.value,
            })),
          );
          entry.phase = "complete";
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
        normalized(results[1], 1),
        normalized(results[0], 0),
        "logical process race " + scenario + mixed,
      );
      const states = await snapshot(
        "logical process race durable state " + scenario + mixed,
      );
      for (const state of states) {
        assert.equal(state.commands.length, scenario === "finish" ? 1 : 2);
        assert.equal(state.turns?.length ?? 0, scenario === "finish" ? 0 : 1);
        assert.equal(
          state.completions?.length ?? 0,
          scenario === "finish" ? 1 : 0,
        );
      }
    }
}
