// Real two-process compare-and-set races, including mixed Node/Rust callers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import {
  interactionRequest,
  protectedInteraction,
  interactionResponse,
  protectedInteractionResponse,
} from "./agent-interaction-fixtures.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE 'UPDATE%agent_interaction_requests%resolution_idempotency_key%'`;
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(
    rows.length,
    count,
    "interaction resolution actual SQL waiter count",
  );
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "interaction updates wait on actual row locks",
  );
  return rows;
}
export async function runAgentInteractionRaces(h) {
  const {
    pair,
    urls,
    root,
    executable,
    owner,
    seed,
    observe,
    snapshot,
    report,
    normalized,
  } = h;
  report.interactionRaces = [];
  for (const mixed of [false, true])
    for (const scenario of [
      "visible",
      "protected",
      "accepted-visible",
      "accepted-protected",
    ]) {
      const protectedRequest = scenario.includes("protected"),
        accepted = scenario.startsWith("accepted");
      await seed("DELETE FROM agent_interaction_requests");
      const admitted = await observe(
        "interaction race setup " + scenario,
        {
          action: protectedRequest ? "record-protected" : "record",
          input: protectedRequest
            ? protectedInteraction("race")
            : interactionRequest("race"),
        },
        { op: "native-command-interaction", shape: "raw" },
      );
      const values = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "interaction-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        const entry = { kind, peerKind, mixed, scenario, phase: "starting" };
        report.interactionRaces.push(entry);
        let held, release;
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM agent_interaction_requests WHERE request_key='race' FOR UPDATE`;
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Interaction row lock ended before contention");
            }),
          ]);
          const enqueue = (fixture, second) => {
            const base = protectedRequest
              ? protectedInteractionResponse
              : interactionResponse;
            const input = {
              ...base,
              idempotencyKey: second ? "second" : "first",
            };
            if (!protectedRequest && second)
              input.response = { kind: "fileChange", decision: "decline" };
            const promise = fixture.request({
              op: "native-command-interaction",
              owner,
              action: protectedRequest ? "resolve-protected" : "resolve",
              requestId: admitted[i].id,
              input,
              accepted: second && accepted,
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
          assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
          assert.equal(outcomes[1].rejected, !accepted, outcomes[1].diagnostic);
          if (accepted)
            assert.deepEqual(
              outcomes[1].value,
              outcomes[0].value,
              "native accepted reply returns the first saved answer",
            );
          else
            assert.equal(
              outcomes[1].diagnostic,
              "Interaction request was resolved concurrently.",
            );
          values.push(
            outcomes.map((r) =>
              r.rejected ? { message: r.diagnostic } : r.value,
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
        "interaction race " + scenario + " mixed=" + mixed,
      );
      const states = await snapshot(
        "interaction race persisted " + scenario + " mixed=" + mixed,
      );
      for (const state of states) {
        assert.equal(state.interactions.length, 1);
        assert.equal(state.interactions[0].status, "resolved");
        assert.equal(state.interactions[0].resolution_idempotency_key, "first");
      }
    }
}
