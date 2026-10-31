// Lock witnesses come from PostgreSQL while two independent server processes wait.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    if (
      rows.length === count &&
      rows.every((row) => row.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "admission SQL lock waiter count");
  assert.ok(
    rows.every((row) => row.wait_event_type === "Lock"),
    "all admissions wait on actual locks",
  );
  return rows;
}
export async function runAdmissionRaces({
  pair,
  urls,
  root,
  executable,
  owner,
  reset,
  snapshot,
  report,
  register,
  normalized,
}) {
  report.races = [];
  for (const mixed of [false, true])
    for (const scenario of ["replay", "conflict", "second-start"]) {
      await reset();
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 });
        let release, held;
        const pending = [];
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
              throw new Error("Admission lock ended before contention");
            }),
          ]);
          const enqueue = (promise) => {
            promise.catch(() => {});
            pending.push(promise);
          };
          enqueue(
            pair[i].request({
              op: "native-command-admit",
              owner,
              input: command(),
            }),
          );
          const first = await waiters(observer, 1);
          const changes =
            scenario === "conflict"
              ? { payloadDigest: "b".repeat(64) }
              : scenario === "second-start"
                ? { operationId: "second" }
                : {};
          enqueue(
            peer.request({
              op: "native-command-admit",
              owner,
              input: command(changes),
            }),
          );
          const both = await waiters(observer, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          report.races.push({
            kind,
            peerKind,
            mixed,
            scenario,
            first,
            both,
            outcomes,
          });
          assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
          assert.equal(outcomes[0].value.receipt.status, "accepted");
          assert.equal(
            outcomes[1].rejected,
            scenario === "conflict",
            outcomes[1].diagnostic,
          );
          if (scenario === "conflict")
            assert.equal(outcomes[1].commandError, "operation-id-conflict");
          else if (scenario === "replay") {
            assert.equal(outcomes[1].value.replayed, true);
            assert.deepEqual(
              outcomes[1].value.receipt,
              outcomes[0].value.receipt,
            );
          } else {
            assert.equal(outcomes[1].value.receipt.status, "rejected");
            assert.equal(
              outcomes[1].value.receipt.rejectionCode,
              "execution-conflict",
            );
          }
          for (const result of outcomes)
            if (result.value?.receipt) {
              register(
                result.value.receipt.operationGeneration,
                "operation",
                i,
              );
              register(
                result.value.receipt.activationGeneration,
                "activation",
                i,
              );
              register(result.value.receipt.executionLaneId, "lane", i);
            }
          results.push(
            outcomes.map((r) =>
              r.rejected
                ? {
                    commandError: r.commandError,
                    commandStatus: r.commandStatus,
                  }
                : r.value,
            ),
          );
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
        `admission race mixed=${mixed} ${scenario}`,
      );
      const states = await snapshot(
        `two-process admission mixed=${mixed} ${scenario}`,
      );
      for (const state of states) {
        assert.equal(
          state.commands.length,
          scenario === "second-start" ? 2 : 1,
        );
        assert.equal(state.lanes.length, 1);
        assert.equal(state.runtimes.length, 1);
        assert.equal(state.leases.length, 1);
        assert.equal(state.activations.length, 1);
        assert.equal(state.activations[0].operation_id, "request");
      }
    }
}
