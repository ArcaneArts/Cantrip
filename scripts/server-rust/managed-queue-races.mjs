// Two real server processes wait on the owning PostgreSQL project row.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
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
  assert.equal(rows.length, count, "managed queue SQL lock waiter count");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "queue operations wait on actual locks",
  );
  return rows;
}
export async function runManagedQueueRaces(h) {
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
  const session = { ...command().session, threadId: "thread" };
  const request = (operationId = "queue-race", extra = {}) => ({
    expectedRevision: 0,
    mutation: { kind: "add", prompt: retainedPrompt(), attachments: [] },
    admission: command({ operationId, method: "thread/queue/add", session }),
    ...extra,
  });
  report.managedQueueRaces = [];
  for (const mixed of [false, true])
    for (const scenario of [
      "replay",
      "revision",
      "claim-next",
      "start",
      "import",
    ]) {
      await reset();
      await seed(
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,created_at,updated_at) VALUES('managed-queue-race-runtime','chat','alpha','github-alpha-main','thread',${literal(stamp)},${literal(stamp)})`,
      );
      if (["claim-next", "start"].includes(scenario))
        await observe(
          "prepare managed queue race " + scenario,
          { action: "mutate", content: request("queue-race-prepare") },
          { op: "native-command-managed-queue-run", shape: "raw" },
        );
      const values = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "managed-queue-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        let held, release;
        const entry = { kind, peerKind, mixed, scenario, phase: "starting" };
        report.managedQueueRaces.push(entry);
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
              throw new Error("Managed queue lock ended before contention");
            }),
          ]);
          const input = (second = false) => {
            if (scenario === "claim-next")
              return { action: "claim-next", chat: "chat" };
            if (scenario === "import")
              return {
                action: "import",
                content: {
                  workerId: "alpha",
                  session,
                  runnerGeneration: "runner",
                  items: [
                    {
                      nativeItemId: "native-race",
                      sourceDigest: "a".repeat(64),
                      protectedSource: retainedPrompt().protectedNativeInput,
                      prompt: retainedPrompt(),
                      attachments: [],
                    },
                  ],
                },
              };
            return {
              action: "mutate",
              content: request(
                second && scenario !== "replay"
                  ? "queue-race-second"
                  : "queue-race",
                scenario === "start"
                  ? {
                      expectedRevision: 1,
                      mutation: { kind: "start" },
                      admission: command({
                        operationId: second
                          ? "queue-race-second"
                          : "queue-race",
                        method: "thread/queue/start",
                        session,
                      }),
                    }
                  : {},
              ),
            };
          };
          const enqueue = (fixture, second) => {
            const promise = fixture.request({
              op: "native-command-managed-queue-run",
              owner,
              ...input(second),
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
          for (const r of outcomes) {
            assert.equal(r.rejected, false, r.diagnostic);
            if (r.value?.receipt)
              register(r.value.receipt.operationGeneration, "operation", i);
            if (scenario === "claim-next") register(r.value.id, "claim", i);
          }
          if (["revision", "start"].includes(scenario)) {
            assert.equal(outcomes[0].value.receipt.status, "applied");
            assert.equal(outcomes[1].value.receipt.status, "rejected");
            assert.equal(
              outcomes[1].value.receipt.rejectionCode,
              "queue-revision-conflict",
            );
          } else
            assert.deepEqual(
              outcomes[1].value,
              outcomes[0].value,
              "concurrent queue replay returns one durable result",
            );
          values.push(outcomes.map((r) => r.value));
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
        `managed queue race mixed=${mixed} ${scenario}`,
      );
      await snapshot(`two-process managed queue mixed=${mixed} ${scenario}`);
    }
}
