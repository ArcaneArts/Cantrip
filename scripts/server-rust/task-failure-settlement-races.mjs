import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { waiters } from "./task-retry-races.mjs";
import { taskEnvelope } from "./task-wire-fixtures.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

// Observe both actors actually blocked at the shared owner lock before release.
// Exercise same-runtime and mixed-runtime replicas in both acquisition orders.
export async function runTaskFailureSettlementRaces(h, clean, fence, now) {
  h.report.taskFailureSettlementRaces = [];
  for (const mode of ["settle", "automatic"])
    for (const mixed of [false, true])
      for (const reverse of [false, true]) {
        await clean();
        for (const [i, kind] of ["node", "rust"].entries()) {
          const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
          const peer = await repositoryFixture({
            kind: peerKind,
            executable: h.executable,
            root: path.join(h.root, "task-settlement-peer"),
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
                throw new Error(
                  "Settlement blocker ended before locking owner",
                );
              }),
            ]);
            const submit = (fixture, input) => {
              const request = fixture.request({
                owner: h.owner,
                chat: "task",
                now,
                ...input,
              });
              request.catch(() => {});
              pending.push(request);
            };
            const settle = (fixture) =>
              submit(fixture, {
                op: "native-command-task-retry",
                action: "settle",
                fence,
                kind: "usage-limit",
              });
            const compete = () =>
              mode === "settle"
                ? settle(peer)
                : submit(peer, {
                    op: "native-command-task-automatic",
                    action: "automatic",
                    retryClock: now,
                    steps: [{ kind: "tick" }, { kind: "drain" }],
                  });
            (reverse ? compete : () => settle(h.pair[i]))();
            const first = await waiters(observer, 1);
            (reverse ? () => settle(h.pair[i]) : compete)();
            const both = await waiters(observer, 2);
            release();
            await held;
            const outcomes = await Promise.all(pending);
            if (mode === "settle") {
              assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
              assert.equal(outcomes[0].value.value, true);
              assert.equal(outcomes[1].rejected, true);
              assert.match(outcomes[1].diagnostic, /lease is stale/);
            } else {
              for (const result of outcomes)
                assert.equal(result.rejected, false, result.diagnostic);
              const actor = outcomes[reverse ? 0 : 1].value;
              assert.equal(actor.error, undefined);
              assert.deepEqual(
                actor.commands,
                [],
                "adoption starts no worker or inference",
              );
            }
            const [row] =
              await observer`SELECT t.automatic_retry,t.row_version,t.scheduler_revision,t.protected_content,c.state
              FROM tasks t JOIN task_dispatch_cycles c ON c.chat_id=t.chat_id WHERE t.chat_id='task'`;
            assert.deepEqual(row.automatic_retry, {
              status: "manual",
              failureKind: "usage-limit",
              failureKey: `dispatch:${fence.cycleId}:${fence.fencingToken}`,
              dueAt: null,
              attempts: [],
              claim: null,
            });
            assert.equal(row.state, "failed");
            assert.equal(row.row_version, 1);
            assert.equal(row.scheduler_revision, 1);
            assert.deepEqual(row.protected_content, taskEnvelope);
            h.report.taskFailureSettlementRaces.push({
              mode,
              kind,
              peerKind,
              reverse,
              witnesses: { first, both },
              outcomes,
              row,
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
