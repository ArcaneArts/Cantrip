import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count, entry) {
  let rows = [],
    previous;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%update%chat_execution_lanes%'`;
    const state = JSON.stringify(rows);
    if (state !== previous) {
      entry.observations.push({ count, rows, at: Date.now() });
      previous = state;
    }
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "lane mutation SQL waiter count");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "lane mutations blocked on actual locks",
  );
  return rows;
}
export async function runLaneTransitionRaces({
  pair,
  urls,
  root,
  executable,
  owner,
  reset,
  observe,
  snapshot,
  report,
  register,
  normalized,
}) {
  report.transitionRaces = [];
  for (const mixed of [false, true])
    for (const scenario of ["release", "cancel", "apply"]) {
      await reset();
      const contexts = await observe("lane race start " + scenario, {}),
        active = contexts.map((c) => c.executionLaneId);
      let lanes = active;
      if (scenario !== "release") {
        const pending = await observe(
          "lane race destination " + scenario,
          (i) => ({
            action: "schedule",
            expectedLane: active[i],
            target: "github-alpha-feature",
          }),
        );
        lanes = pending.map((p) => p.lane.id);
      }
      if (scenario !== "cancel")
        await observe("lane race captured idle context " + scenario, (i) => ({
          action: "finish",
          lane: active[i],
        }));
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "lane-transition-peer"),
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
          observations: [],
          phase: "starting",
        };
        report.transitionRaces.push(entry);
        let release, held;
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM chat_execution_lanes WHERE id=${lanes[i]} FOR UPDATE`;
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Lane mutation blocker ended early");
            }),
          ]);
          const request = {
            op: "native-command-lane-run",
            action: scenario,
            owner,
            chat: "chat",
            lane: lanes[i],
            returnToPrimary: false,
          };
          const enqueue = (p) => {
            p.catch(() => {});
            pending.push(p);
          };
          enqueue(pair[i].request(request));
          entry.first = await waiters(observer, 1, entry);
          enqueue(peer.request(request));
          entry.both = await waiters(observer, 2, entry);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
          if (scenario === "apply") {
            assert.equal(outcomes[1].rejected, true);
            assert.match(
              outcomes[1].diagnostic,
              /Database returned no row after applying a worktree transition/,
            );
          } else {
            assert.equal(outcomes[1].rejected, false, outcomes[1].diagnostic);
            if (scenario === "cancel") {
              assert.equal(outcomes[0].value, true);
              assert.equal(outcomes[1].value, true);
            } else {
              assert.equal(outcomes[0].value.lane.state, "released");
              assert.equal(
                outcomes[1].value.lane.state,
                "suspended",
                "second release returns its captured pre-transaction context",
              );
            }
          }
          for (const result of outcomes) {
            if (result.value?.lane) {
              register(result.value.lane.id, "lane", i);
              register(result.value.lane.runtimeSessionId, "runtime", i);
            }
          }
          results.push(
            outcomes.map((r) => ({
              rejected: r.rejected,
              value: r.value,
              ...(r.rejected ? { message: r.diagnostic } : {}),
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
        "lane mutation race " + scenario + mixed,
      );
      await snapshot("lane mutation race committed state " + scenario + mixed);
    }
}
