import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import { settingsSnapshot } from "./native-settings-fixtures.mjs";
import { command } from "./native-command-admission-cases.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count, entry) {
  const deadline = Date.now() + 20000;
  let rows = [],
    prior;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    const state = JSON.stringify(rows);
    if (state !== prior) {
      entry.observations.push({ count, at: Date.now(), rows });
      prior = state;
    }
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "actual evidence project lock waiters");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "evidence requests wait on actual SQL locks",
  );
  return rows;
}
export async function runEvidenceRaces({
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
}) {
  report.evidenceRaces = [];
  const session = {
    ...command().session,
    threadId: "thread",
    runtimeGeneration: "runtime",
    connectionId: "connection",
  };
  for (const mixed of [false, true])
    for (const scenario of ["replay", "contradictory"]) {
      await reset();
      await seed(
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('evidence-race-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
      );
      const published = await observe(
        "publish concurrent permission source",
        { chat: "chat", snapshot: settingsSnapshot },
        { op: "native-command-settings-refresh", shape: "raw" },
      );
      const admitted = await observe(
        "admit concurrent permission choice",
        (i) =>
          command({
            session,
            method: "thread/settings/update",
            intent: {
              settingsBindingId: published[i].state.binding.bindingId,
              nativeSettingsOperationId: "native-settings",
              settingKeys: ["permissions"],
              permissionTransition: {
                selectedId: ":read-only",
                resolvedSelectedId: ":read-only",
                effectiveId: ":read-only",
                expectedRevision: "0",
              },
            },
          }),
      );
      await observe(
        "dispatch concurrent permission choice",
        (i) => ({
          workerId: "alpha",
          operationId: "request",
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
          root: path.join(root, "evidence-peer"),
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
        report.evidenceRaces.push(entry);
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
              throw new Error("Evidence lock ended before contention");
            }),
          ]);
          const input = {
            workerId: "alpha",
            operationId: "request",
            operationGeneration: admitted[i].receipt.operationGeneration,
            eventId: "12345678-1234-4234-8234-000000000001",
            threadId: "thread",
            runtimeGeneration: "runtime",
            nativeOperationId: "native-settings",
            submissionId: "submission",
            kind: "applied",
            resultDigest: "a".repeat(64),
            protectedResult: command().protectedPayload,
            permissionPolicy: {
              effectiveId: ":read-only",
              settingsVersion: { epoch: "epoch", revision: "5" },
            },
          };
          const enqueue = (p) => {
            p.catch(() => {});
            pending.push(p);
          };
          enqueue(
            pair[i].request({ op: "native-command-evidence", owner, input }),
          );
          entry.phase = "first-wait";
          entry.first = await waiters(observer, 1, entry);
          const next = { ...input };
          if (scenario === "contradictory") {
            next.eventId = "12345678-1234-4234-8234-000000000002";
            next.kind = "rejected";
            delete next.permissionPolicy;
          }
          enqueue(
            peer.request({ op: "native-command-evidence", owner, input: next }),
          );
          entry.phase = "both-wait";
          entry.both = await waiters(observer, 2, entry);
          release();
          await held;
          entry.phase = "settling";
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          for (const result of outcomes)
            assert.equal(result.rejected, false, result.diagnostic);
          assert.equal(outcomes[0].value.application.status, "applied");
          assert.equal(outcomes[0].value.permissionPolicyPublished, true);
          assert.equal(
            outcomes[1].value.application.status,
            scenario === "replay" ? "applied" : "uncertain",
          );
          assert.equal(
            outcomes[1].value.application.evidenceCount,
            scenario === "replay" ? 1 : 2,
          );
          assert.equal(
            outcomes[1].value.permissionPolicyPublished,
            scenario === "replay",
          );
          results.push(outcomes.map((r) => r.value));
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
        `evidence processes mixed=${mixed} ${scenario}`,
      );
      const states = await snapshot(
        `actual evidence contention mixed=${mixed} ${scenario}`,
      );
      for (const state of states) {
        assert.equal(state.evidence.length, scenario === "replay" ? 1 : 2);
        assert.equal(state.settings[0].state.permissionPolicy.revision, "1");
        assert.equal(state.commands[0].status, "dispatched");
        assert.equal(
          state.commands[0].settings_application.status,
          scenario === "replay" ? "applied" : "uncertain",
        );
      }
    }
}
