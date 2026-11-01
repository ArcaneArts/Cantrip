// Real overlapping repository writes on independent connections and processes,
// including both directions of mixed Node/Rust ownership.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { stamp } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
async function witness(sql, fragment, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE ${"%" + fragment + "%"} AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await sleep(20);
  }
  assert.equal(
    rows.length,
    count,
    "actual concurrent telemetry SQL lock waiters",
  );
  return rows;
}
export async function runGuiTelemetryRaces(h) {
  const {
    pair,
    urls,
    root,
    executable,
    owner,
    capture,
    base,
    clean,
    snapshot,
    report,
  } = h;
  report.guiTelemetryRaces = [];
  for (const mixed of [false, true])
    for (const scenario of [
      "behavior-captures",
      "behavior-terminal",
      "usage-responses",
    ]) {
      await clean();
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "telemetry-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 });
        const pending = [];
        let release, held, locked;
        const gate = new Promise((resolve) => (release = resolve)),
          acquired = new Promise((resolve) => (locked = resolve));
        try {
          const key = JSON.stringify(["model-behavior", owner, base.sourceKey]);
          held = blocker.begin(async (sql) => {
            if (scenario === "usage-responses")
              await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
            else
              await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
            locked();
            await gate;
          });
          await Promise.race([
            acquired,
            held.then(() => {
              throw new Error(
                "Telemetry blocker ended before acquiring its lock",
              );
            }),
          ]);
          const request = (which) => {
            let action, record;
            if (scenario === "usage-responses") {
              action = "usage";
              const n = which ? 20 : 10;
              record = {
                ...base,
                sourceKey: which ? "race-observer-b" : "race-observer-a",
                turnId: capture.turnId,
                nativeModelAttribution: capture,
                nativeUsage: {
                  version: 1,
                  modelAttribution: capture,
                  responses: [
                    {
                      responseId: which ? "response-b" : "response-a",
                      usage: {
                        totalTokens: n * 2,
                        inputTokens: n,
                        cachedInputTokens: 0,
                        cacheWriteInputTokens: 0,
                        outputTokens: n,
                        reasoningOutputTokens: 0,
                      },
                    },
                  ],
                  complete: false,
                  conflictingResponseIds: [],
                },
              };
            } else {
              action = "behavior";
              const observed = which
                ? {
                    ...capture,
                    threadId: "child",
                    turnId: "child-turn",
                    isRoot: false,
                  }
                : capture;
              record = {
                ...base,
                nativeAttribution: {
                  version: 1,
                  turnIds: [observed.turnId],
                  captures: [observed],
                  conflictingTurnKeys: [],
                },
                ...(scenario === "behavior-terminal"
                  ? {
                      attemptStatus: which ? "running" : "completed",
                      toolCallCount: which ? 0 : 8,
                      finalAnswerAppeared: !which,
                      completedAt: which ? null : stamp,
                      finalizedAt: which ? null : stamp,
                    }
                  : {}),
              };
            }
            const promise = (which ? peer : pair[i]).request({
              op: "native-command-gui-telemetry",
              owner,
              action,
              record,
            });
            promise.catch(() => {});
            pending.push(promise);
          };
          const fragment =
            scenario === "usage-responses"
              ? "locked_project"
              : "pg_advisory_xact_lock";
          request(0);
          const first = await witness(observer, fragment, 1);
          request(1);
          const both = await witness(observer, fragment, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          for (const outcome of outcomes)
            assert.equal(outcome.rejected, false, outcome.diagnostic);
          results.push({
            kind,
            peerKind,
            witnesses: { first, both },
            outcomes,
          });
        } finally {
          release();
          if (held) await held.catch(() => {});
          await Promise.allSettled(pending);
          await peer.close();
          await Promise.all([blocker.end(), observer.end()]);
        }
      }
      const states = await snapshot(
        "actual " +
          (mixed ? "mixed " : "same-runtime ") +
          scenario +
          " telemetry race",
      );
      for (const state of states) {
        if (scenario === "usage-responses") {
          assert.equal(state.usageRecords.length, 1);
          const row = state.usageRecords[0];
          assert.equal(row.input_tokens, 30);
          assert.equal(row.output_tokens, 30);
          assert.equal(row.reported_total_tokens, null);
          assert.equal(row.native_usage.responses.length, 2);
          assert.deepEqual(row.source_aliases, [
            "race-observer-a",
            "race-observer-b",
          ]);
        } else {
          assert.equal(state.behaviorRecords.length, 1);
          const row = state.behaviorRecords[0];
          assert.equal(row.native_attribution.captures.length, 2);
          assert.equal(row.native_attribution.turnIds.length, 2);
          assert.equal(row.model_route_id, "gui-chosen");
          if (scenario === "behavior-terminal") {
            assert.equal(row.attempt_status, "completed");
            assert.equal(row.tool_call_count, 8);
            assert.equal(row.final_answer_appeared, true);
          }
        }
      }
      report.guiTelemetryRaces.push({ scenario, mixed, results, passed: true });
    }
  await clean();
}
