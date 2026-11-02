// Real project-row contention between independently running server processes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { eventually } from "./full-worker.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");

export async function runThreadObservationRaces(h) {
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
    register,
    normalized,
  } = h;
  report.threadObservationRaces = [];
  const prepare = async () => {
    await reset();
    await seed(
      "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('observed-race-runtime','chat','alpha','github-alpha-main','observed-race-thread')",
    );
  };
  const read = (name) =>
    observe(
      name,
      { chat: "chat" },
      { op: "native-command-context", shape: "raw" },
    );
  const admission = command({
    operationId: "observed-race-command",
    session: { threadId: "observed-race-thread" },
  });
  const request = { op: "native-command-admit", owner, input: admission };
  for (const mixed of [false, true])
    for (const scenario of [
      "admission-first",
      "observation-first",
      "preparation-completion",
    ]) {
      await prepare();
      const initial = await read(`race ${mixed} ${scenario} initial binding`);
      let admitted;
      if (scenario === "preparation-completion")
        admitted = await observe(
          `race ${mixed} admits GUI preparation`,
          admission,
        );
      const current = await read(`race ${mixed} ${scenario} current binding`);
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "observed-race-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        const entry = { kind, peerKind, mixed, scenario, phase: "starting" };
        report.threadObservationRaces.push(entry);
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
              throw new Error(
                "Thread observation blocker ended before contention",
              );
            }),
          ]);
          const passive = {
            op: "native-command-observe-thread",
            owner,
            expected:
              scenario === "preparation-completion" ? current[i] : initial[i],
            status: scenario === "observation-first" ? "running" : "idle",
          };
          const dispatch =
            scenario === "preparation-completion"
              ? {
                  op: "native-command-dispatch",
                  owner,
                  input: {
                    workerId: "alpha",
                    operationId: admission.operationId,
                    operationGeneration:
                      admitted[i].receipt.operationGeneration,
                    payloadDigest: admission.payloadDigest,
                    session: {
                      ...admission.session,
                      runtimeGeneration: "observed-race-generation",
                      connectionId: "observed-race-connection",
                    },
                  },
                }
              : request;
          const enqueue = (fixture, value) => {
            const p = fixture.request(value);
            p.catch(() => {});
            pending.push(p);
          };
          const waiters = (count) =>
            eventually(
              () =>
                observer`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`,
              (rows) => {
                assert.equal(
                  rows.length,
                  count,
                  "actual project-row SQL waiters",
                );
                assert.ok(rows.every((r) => r.wait_event_type === "Lock"));
                return rows;
              },
              20000,
            );
          enqueue(pair[i], scenario === "admission-first" ? request : passive);
          entry.first = await waiters(1);
          enqueue(peer, scenario === "admission-first" ? passive : dispatch);
          entry.both = await waiters(2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          for (const outcome of outcomes)
            assert.equal(outcome.rejected, false, outcome.diagnostic);
          if (scenario === "admission-first") {
            assert.equal(outcomes[0].value.receipt.status, "accepted");
            assert.equal(outcomes[1].value.applied, false);
          } else if (scenario === "observation-first") {
            assert.equal(outcomes[0].value.applied, true);
            assert.equal(outcomes[1].value.receipt.status, "rejected");
            assert.equal(
              outcomes[1].value.receipt.rejectionCode,
              "execution-conflict",
            );
          } else {
            assert.equal(outcomes[0].value.applied, false);
            assert.equal(outcomes[1].value.receipt.status, "dispatched");
          }
          for (const { value } of outcomes) {
            register(value.execution?.executionLaneId, "lane", i);
            register(value.receipt?.operationGeneration, "operation", i);
            register(value.receipt?.activationGeneration, "activation", i);
            register(value.receipt?.executionLaneId, "lane", i);
          }
          results.push(outcomes.map(({ value }) => value));
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
        `thread observation ${mixed} ${scenario}`,
      );
      const state = await snapshot(
        `thread observation ${mixed} ${scenario} committed state`,
      );
      for (const value of state) {
        assert.equal(
          value.chats.find((c) => c.id === "chat").status,
          "running",
        );
        assert.equal(value.lanes.length, 1);
        assert.equal(value.lanes[0].state, "active");
        assert.equal(
          value.activations?.filter((a) => a.active).length ?? 0,
          scenario === "observation-first" ? 0 : 1,
        );
      }
    }
  await prepare();
  const expected = await read("fault injection console binding");
  const before = await snapshot("before passive lane SQL exception");
  await seed(
    "CREATE FUNCTION observed_lane_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'observed lane fixture failure'; END $$; CREATE TRIGGER observed_lane_failure AFTER INSERT ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION observed_lane_failure()",
  );
  try {
    await observe(
      "passive lane SQL failure rolls back Chat runtime lane and branch lease",
      (i) => ({ expected: expected[i], status: "running" }),
      {
        op: "native-command-observe-thread",
        shape: "raw",
        error: true,
        sqlstate: "P0001",
      },
    );
    assert.deepEqual(
      await snapshot("passive lane exception commits no partial state"),
      before,
    );
    report.threadObservationSqlRollback = true;
  } finally {
    await seed(
      "DROP TRIGGER observed_lane_failure ON chat_execution_lanes; DROP FUNCTION observed_lane_failure()",
    );
  }
}
