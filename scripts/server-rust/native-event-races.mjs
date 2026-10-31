// Events capture their command before waiting on a real project row lock.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { eventMessage, eventPlan } from "./native-event-fixtures.mjs";
import { literal, stamp } from "./project-target-state.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "native event SQL lock waiter count");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "native events wait on actual SQL locks",
  );
  return rows;
}
export async function runNativeEventRaces(h) {
  const {
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
    normalized,
  } = h;
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  report.nativeEventRaces = [];
  for (const mixed of [false, true])
    for (const scenario of ["write", "captured-status", "rollback"]) {
      await reset();
      await seed([
        "DELETE FROM chat_messages",
        "UPDATE chats SET experience='agent',protected_plan=NULL,has_pending_plan_question=false WHERE id='chat'",
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('native-event-race-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
      ]);
      const admitted = await observe(
        "native event race admission " + scenario,
        command({ operationId: "native-event-race", session }),
      );
      await observe(
        "native event race dispatch " + scenario,
        (i) => ({
          workerId: "alpha",
          operationId: "native-event-race",
          operationGeneration: admitted[i].receipt.operationGeneration,
          payloadDigest: "a".repeat(64),
          session,
        }),
        { op: "native-command-dispatch", status: "dispatched" },
      );
      const values = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "native-event-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        let held, release;
        const entry = { kind, peerKind, mixed, scenario, phase: "starting" };
        report.nativeEventRaces.push(entry);
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
            ready();
            await unlocked;
            if (scenario === "captured-status")
              await sql`UPDATE native_commands SET status='rejected' WHERE operation_id='native-event-race'`;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Native event lock ended before contention");
            }),
          ]);
          const enqueue = (fixture, second) => {
            const promise = fixture.request({
              op: "native-command-event-context",
              owner,
              worker: "alpha",
              operation: "native-event-race",
              generation: admitted[i].receipt.operationGeneration,
              action: scenario === "rollback" && !second ? "rollback" : "write",
              message: {
                ...eventMessage,
                classification: {
                  ...eventMessage.classification,
                  role: second ? "assistant" : "user",
                },
              },
              plan: { ...eventPlan, classification: { hasQuestion: !second } },
            });
            promise.catch(() => {});
            pending.push(promise);
          };
          enqueue(pair[i], false);
          entry.first = await waiters(observer, 1);
          enqueue(peer, true);
          entry.both = await waiters(observer, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          assert.equal(
            outcomes[0].rejected,
            scenario === "rollback",
            outcomes[0].diagnostic,
          );
          if (scenario === "rollback")
            assert.equal(
              outcomes[0].commandError,
              "fixture-native-event-rollback",
            );
          assert.equal(outcomes[1].rejected, false, outcomes[1].diagnostic);
          assert.equal(outcomes[1].value.saved.id, eventMessage.id);
          values.push(
            outcomes.map((r) =>
              r.rejected
                ? { code: r.commandError, status: r.commandStatus }
                : r.value,
            ),
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
        normalized(values[1], 1),
        normalized(values[0], 0),
        `native event race mixed=${mixed} ${scenario}`,
      );
      const states = await snapshot(
        `two-process native event mixed=${mixed} ${scenario}`,
      );
      for (const s of states) {
        assert.equal(s.messages.length, 1);
        assert.equal(s.messages[0].role, "assistant");
        assert.equal(
          s.chats.find((c) => c.id === "chat").protected_plan.classification
            .hasQuestion,
          false,
        );
        if (scenario === "captured-status")
          assert.equal(
            s.commands.find((c) => c.operation_id === "native-event-race")
              .status,
            "rejected",
          );
      }
    }
}
