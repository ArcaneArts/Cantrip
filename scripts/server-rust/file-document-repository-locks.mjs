// Witness the executing transaction's locks, then race real authority changes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { state, literal } from "./project-target-state.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
async function blocked(observer, pid, pattern) {
  const end = Date.now() + 10000;
  for (;;) {
    const rows =
      await observer`SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))`;
    if (rows.length) {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].wait_event_type, "Lock");
      assert.match(rows[0].query, pattern);
      return rows[0];
    }
    assert.ok(
      Date.now() < end,
      "actual document operation reaches the held authority lock",
    );
    await delay(10);
  }
}
export async function fileDocumentRepositoryLocks({
  pair,
  urls,
  owner,
  other,
  report,
  normalize,
}) {
  report.lockRaces = [];
  const scenarios = [
    {
      name: "source removed while selecting authority",
      table: "project_sources",
      id: "github-alpha",
      change:
        "UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'",
      restore:
        "UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'",
    },
    {
      name: "worker unlinked while selecting authority",
      table: "workers",
      id: "alpha",
      change: "UPDATE workers SET unlinked_at=now() WHERE id='alpha'",
      restore: "UPDATE workers SET unlinked_at=NULL WHERE id='alpha'",
    },
    {
      name: "checkout becomes unavailable while selecting authority",
      table: "project_worktrees",
      id: "github-alpha-main",
      change:
        "UPDATE project_worktrees SET lifecycle_state='creating' WHERE id='github-alpha-main'",
      restore:
        "UPDATE project_worktrees SET lifecycle_state='ready' WHERE id='github-alpha-main'",
    },
    {
      name: "project ownership changes while selecting authority",
      table: "projects",
      id: "folder",
      project: "folder",
      worktree: "folder-alpha-main",
      change: `UPDATE projects SET owner_id=${literal(other)} WHERE id='folder'`,
      restore: `UPDATE projects SET owner_id=${literal(owner)} WHERE id='folder'`,
    },
  ];
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const outcomes = [];
    for (let i = 0; i < pair.length; i++) {
      const observer = postgres(urls[i], { max: 1 }),
        locker = postgres(urls[i], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, pid;
      const id = `eeeeeeee-eeee-4eee-8eee-${String(scenarioIndex + 1).padStart(12, "0")}`;
      try {
        transaction = locker.begin(async (sql) => {
          pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          await sql.unsafe(
            `SELECT id FROM ${scenario.table} WHERE id=${literal(scenario.id)} FOR UPDATE`,
          );
          held.resolve();
          await release.promise;
          await sql.unsafe(scenario.change);
        });
        transaction.catch(held.reject);
        await held.promise;
        pending = pair[i].request({
          op: "document-create",
          owner,
          project: scenario.project ?? "github",
          input: {
            id,
            worktreeId: scenario.worktree ?? "github-alpha-main",
            stateProtection: state("file-document-state"),
          },
        });
        const waiting = await blocked(
          observer,
          pid,
          /project_worktrees.*for update/i,
        );
        const locks =
          await observer`SELECT mode FROM pg_locks WHERE pid=${waiting.pid} AND NOT granted`;
        assert.ok(locks.length > 0);
        release.resolve();
        await transaction;
        const response = await pending;
        assert.equal(response.rejected, false, response.diagnostic);
        assert.equal(response.value, null);
        const stored =
          await observer`SELECT id FROM file_documents WHERE id=${id}`;
        assert.equal(
          stored.length,
          0,
          "no document is inserted after authority disappears",
        );
        outcomes.push({
          response,
          waiting: { query: waiting.query, type: waiting.wait_event_type },
          locks,
        });
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await observer.unsafe(scenario.restore);
        await observer.end({ timeout: 5 });
        await locker.end({ timeout: 5 });
      }
    }
    assert.deepEqual(
      normalize(outcomes[1].response),
      normalize(outcomes[0].response),
      scenario.name,
    );
    report.lockRaces.push({ name: scenario.name, outcomes });
  }
  const outcomes = [];
  for (let i = 0; i < pair.length; i++) {
    const observer = postgres(urls[i], { max: 1 }),
      locker = postgres(urls[i], { max: 1 }),
      mutator = postgres(urls[i], { max: 1 });
    const held = deferred(),
      release = deferred();
    let transaction, pending, mutation, pid;
    const id = "eeeeeeee-eeee-4eee-8eee-000000000005",
      key = 83214231;
    try {
      await observer.unsafe(
        `CREATE FUNCTION document_lock_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
      );
      await observer.unsafe(
        "CREATE TRIGGER document_lock_insert BEFORE INSERT ON file_documents FOR EACH ROW EXECUTE FUNCTION document_lock_insert()",
      );
      transaction = locker.begin(async (sql) => {
        pid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
        await sql`SELECT pg_advisory_xact_lock(${key})`;
        held.resolve();
        await release.promise;
      });
      transaction.catch(held.reject);
      await held.promise;
      pending = pair[i].request({
        op: "document-create",
        owner,
        project: "github",
        input: {
          id,
          worktreeId: "github-alpha-main",
          stateProtection: state("file-document-state"),
        },
      });
      const insertion = await blocked(
        observer,
        pid,
        /insert into "file_documents"/i,
      );
      mutation = mutator`UPDATE project_sources SET removed_at=now() WHERE id='github-alpha'`;
      const mutating = Promise.resolve(mutation);
      const removal = await blocked(
        observer,
        insertion.pid,
        /UPDATE project_sources/i,
      );
      release.resolve();
      await transaction;
      const response = await pending;
      await mutating;
      assert.equal(response.rejected, false, response.diagnostic);
      assert.equal(response.value.id, id);
      const context = await pair[i].request({
        op: "document-context",
        owner,
        document: id,
      });
      assert.equal(context.value, null);
      const stored =
        await observer`SELECT id FROM file_documents WHERE id=${id}`;
      assert.equal(stored.length, 1);
      outcomes.push({
        response,
        context,
        insertWait: { query: insertion.query, type: insertion.wait_event_type },
        removalWait: { query: removal.query, type: removal.wait_event_type },
      });
    } finally {
      release.resolve();
      await transaction?.catch(() => {});
      await pending?.catch(() => {});
      await mutation?.catch(() => {});
      await observer.unsafe(
        "DROP TRIGGER IF EXISTS document_lock_insert ON file_documents",
      );
      await observer.unsafe("DROP FUNCTION IF EXISTS document_lock_insert()");
      await observer`UPDATE project_sources SET removed_at=NULL WHERE id='github-alpha'`;
      await observer`DELETE FROM file_documents WHERE id=${id}`;
      await observer.end({ timeout: 5 });
      await locker.end({ timeout: 5 });
      await mutator.end({ timeout: 5 });
    }
  }
  assert.deepEqual(
    normalize(outcomes[1].response),
    normalize(outcomes[0].response),
    "authority locks remain held until document commit",
  );
  report.lockRaces.push({
    name: "authority locks remain held through insertion commit",
    outcomes,
  });
}
