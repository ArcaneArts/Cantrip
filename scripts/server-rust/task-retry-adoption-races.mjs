// Real actors contend with precise worker failures at the shared owner lock.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { waiters } from "./task-retry-races.mjs";
import { json, stamp } from "./project-target-state.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function runTaskRetryAdoptionRaces(h, clean) {
  h.report.taskRetryAdoptionRaces = [];
  for (const mixed of [false, true])
    for (const preciseFirst of [true, false]) {
      const observedError = {
        code: "task-operation-failed",
        operationKind: "direct",
        occurredAt: stamp,
      };
      await clean([
        `UPDATE tasks SET last_error=${json(observedError)} WHERE chat_id='task'`,
      ]);
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable: h.executable,
          root: path.join(h.root, "task-retry-adoption-peer"),
          databaseMode: "postgres",
          databaseUrl: h.urls[i],
        });
        const blocker = postgres(h.urls[i], { max: 1 });
        const observer = postgres(h.urls[i], { max: 1 });
        const pending = [];
        let release, locked, held;
        const acquired = new Promise((resolve) => (locked = resolve));
        const gate = new Promise((resolve) => (release = resolve));
        try {
          held = blocker.begin(async (sql) => {
            await sql`SELECT id FROM users WHERE id=${h.owner} FOR UPDATE`;
            locked();
            await gate;
          });
          await Promise.race([
            acquired,
            held.then(() => {
              throw new Error("Adoption blocker ended before locking owner");
            }),
          ]);
          const submit = (fixture, input) => {
            const request = fixture.request(input);
            request.catch(() => {});
            pending.push(request);
          };
          const precise = () =>
            submit(h.pair[i], {
              op: "native-command-task-retry",
              action: "note",
              owner: h.owner,
              chat: "task",
              key: "precise-worker-failure",
              kind: "usage-limit",
              now: 60000,
            });
          const adopt = () =>
            submit(peer, {
              op: "native-command-task-automatic",
              action: "automatic",
              owner: h.owner,
              chat: "task",
              now: 60000,
              retryClock: 60000,
              steps: [{ kind: "tick" }, { kind: "drain" }],
            });
          (preciseFirst ? precise : adopt)();
          const first = await waiters(observer, 1);
          (preciseFirst ? adopt : precise)();
          const both = await waiters(observer, 2);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          for (const outcome of outcomes) {
            assert.equal(outcome.rejected, false, outcome.diagnostic);
            assert.equal(
              outcome.value.error,
              undefined,
              JSON.stringify(outcome.value.error),
            );
          }
          const actor = outcomes[preciseFirst ? 1 : 0].value;
          assert.deepEqual(actor.commands, [], "adoption starts no worker IO");
          const [row] = await observer`
            SELECT state,automatic_retry,row_version,scheduler_revision,
              protected_content,last_error,updated_at
            FROM tasks WHERE chat_id='task'`;
          assert.deepEqual(row.automatic_retry, {
            status: "manual",
            failureKind: "usage-limit",
            failureKey: "precise-worker-failure",
            dueAt: null,
            attempts: [],
            claim: null,
          });
          assert.equal(row.state, "failed");
          assert.equal(row.row_version, 1);
          assert.equal(row.scheduler_revision, 1);
          assert.deepEqual(row.protected_content, taskEnvelope);
          assert.deepEqual(row.last_error, observedError);
          assert.equal(new Date(row.updated_at).getTime(), Date.parse(stamp));
          h.report.taskRetryAdoptionRaces.push({
            kind,
            peerKind,
            preciseFirst,
            witnesses: { first, both },
            finalRecord: row.automatic_retry,
            passed: true,
          });
        } finally {
          release();
          if (held) await held.catch(() => {});
          await Promise.allSettled(pending);
          await peer.close();
          await Promise.all([blocker.end(), observer.end()]);
        }
      }
    }
}
