import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const worker = "79797979-7979-4797-8797-000000000001";
async function waiters(sql, table, count) {
  const until = Date.now() + 20000;
  let rows = [];
  do {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE ${"%" + table + "%"} AND wait_event_type='Lock'`;
    if (rows.length === count) return rows;
    await delay(20);
  } while (Date.now() < until);
  assert.equal(
    rows.length,
    count,
    "actual competing Task Worker/pause SQL lock waiters",
  );
}
export async function runTaskWorkerRaces(h, clean) {
  h.report.taskWorkerRaces = [];
  for (const mode of [
    "create",
    "update",
    "delete-first",
    "delete-second",
    "pause",
  ])
    for (const mixed of [false, true])
      for (const reverse of [false, true]) {
        await clean([
          `INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,position) VALUES('${worker}',${literal(h.owner)},'Race','tw-root','family',0)`,
        ]);
        for (const [i, kind] of ["node", "rust"].entries()) {
          const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
          const peer = await repositoryFixture({
            kind: peerKind,
            executable: h.executable,
            root: path.join(h.root, "task-workers-peer"),
            databaseMode: "postgres",
            databaseUrl: h.urls[i],
          });
          const blocker = postgres(h.urls[i], { max: 1 }),
            observer = postgres(h.urls[i], { max: 1 });
          let release, locked, held;
          const pending = [];
          const acquired = new Promise((r) => (locked = r)),
            gate = new Promise((r) => (release = r));
          try {
            held = blocker.begin(async (sql) => {
              if (mode === "pause" || mode === "create")
                await sql`SELECT id FROM users WHERE id=${h.owner} FOR UPDATE`;
              else
                await sql`SELECT id FROM task_workers WHERE id=${worker} FOR UPDATE`;
              locked();
              await gate;
            });
            await Promise.race([
              acquired,
              held.then(() => {
                throw new Error(
                  "Task Worker blocker ended before acquiring lock",
                );
              }),
            ]);
            const request = (actor, index) => {
              const action =
                mode === "delete-first"
                  ? index === 0
                    ? "delete"
                    : "update"
                  : mode === "delete-second"
                    ? index === 0
                      ? "update"
                      : "delete"
                    : mode;
              const input =
                action === "create"
                  ? {
                      name: "Concurrent " + index,
                      modelConfiguration: { modelId: "tw-root" },
                    }
                  : action === "pause"
                    ? { paused: true, rowVersion: 1 }
                    : { name: "Concurrent " + index, rowVersion: 1 };
              const promise = actor.request({
                op: "native-command-task-workers",
                owner: h.owner,
                worker,
                project: "github",
                action,
                input,
                rowVersion: 1,
              });
              promise.catch(() => {});
              pending.push(promise);
            };
            request(reverse ? peer : h.pair[i], 0);
            const first = await waiters(
              observer,
              mode === "pause" ? "users" : "task_workers",
              1,
            );
            request(reverse ? h.pair[i] : peer, 1);
            const both = await waiters(
              observer,
              mode === "pause" ? "users" : "task_workers",
              2,
            );
            release();
            await held;
            const outcomes = await Promise.all(pending);
            assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
            if (mode === "create") {
              assert.ok(outcomes[0].value.value.id);
              assert.equal(outcomes[1].rejected, true, outcomes[1].diagnostic);
              assert.equal(outcomes[1].databaseCode, "23505");
              const rows =
                await observer`SELECT name,position FROM task_workers ORDER BY position`;
              assert.deepEqual(
                rows.map((r) => [r.name, r.position]),
                [
                  ["Race", 0],
                  ["Concurrent 0", 1],
                ],
              );
            } else {
              assert.equal(outcomes[1].rejected, false, outcomes[1].diagnostic);
              assert.deepEqual(outcomes[1].value.error, {
                code: "stale-version",
                message:
                  mode === "pause"
                    ? "The Project Task pause state changed before this update was applied."
                    : mode === "delete-second"
                      ? "The Task Worker changed before it was removed."
                      : "The Task Worker changed before this update was applied.",
              });
              if (mode === "pause") {
                assert.equal(outcomes[0].value.value.rowVersion, 2);
                const [row] =
                  await observer`SELECT task_scheduling_revision,task_scheduling_paused FROM projects WHERE id='github'`;
                assert.deepEqual(row, {
                  task_scheduling_revision: 2,
                  task_scheduling_paused: true,
                });
              } else {
                const [row] =
                  await observer`SELECT row_version,name,enabled,deleted_at IS NOT NULL AS deleted FROM task_workers WHERE id=${worker}`;
                assert.equal(row.row_version, 2);
                assert.equal(row.deleted, mode === "delete-first");
                if (mode === "delete-first") {
                  assert.equal(outcomes[0].value.value, true);
                  assert.equal(row.enabled, false);
                } else assert.equal(row.name, "Concurrent 0");
              }
            }
            h.report.taskWorkerRaces.push({
              mode,
              kind,
              peerKind,
              reverse,
              witnesses: { first, both },
              outcomes,
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
