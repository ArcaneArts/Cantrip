// Block the real document INSERT, abort its caller, then shut down before commit.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { targetStateSql, state } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-document-shutdown-")),
  reportPath = option("--report");
const report = {
  suite: "document-admitted-insert-shutdown",
  completeReplacement: false,
  runtimes: [],
};
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const databaseUrl = await pg.database();
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "document-shutdown",
      databaseMode: "postgres",
      environment: { DATABASE_URL: databaseUrl },
    });
    const result = { kind, observations: [], passed: false };
    report.runtimes.push(result);
    const sql = postgres(databaseUrl, { max: 2 }),
      abort = new AbortController();
    let repository, held, pending, closing;
    const visit = async (name, method, url, options = {}) => {
      result.observations.push({
        name,
        ...(await fixture.observe(name, method, url, options)),
      });
      return fixture.records.get(name);
    };
    try {
      await fixture.start();
      await visit("session", "GET", "/api/auth/session");
      await fixture.close();
      repository = await repositoryFixture({
        kind,
        executable: repositoryBinary,
        root: path.join(root, fixture.name),
        databaseMode: "postgres",
        databaseUrl,
      });
      for (const statement of targetStateSql())
        await repository.seed(statement);
      await repository.close();
      repository = undefined;
      await fixture.start();
      held = await sql.reserve();
      await held.unsafe("BEGIN");
      const holder = (await held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
      await held.unsafe("LOCK TABLE file_documents IN SHARE MODE");
      const input = {
        id: "dddddddd-dddd-4ddd-8ddd-000000000099",
        worktreeId: "github-alpha-main",
        stateProtection: state("file-document-state"),
      };
      pending = fetch(
        fixture.server.origin + "/api/projects/github/file-documents",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify(input),
          signal: abort.signal,
        },
      ).then(
        (response) => ({ status: response.status }),
        (error) => ({ error: error.name }),
      );
      const blocked = await eventually(
        () =>
          sql.unsafe(
            "SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%file_documents%'",
            [holder],
          ),
        (rows) =>
          assert.equal(
            rows.length,
            1,
            "actual document INSERT waits after authority selection",
          ),
      );
      assert.equal(blocked[0].wait_event_type, "Lock");
      result.blocked = { holder, rows: blocked };
      abort.abort();
      assert.deepEqual(await pending, { error: "AbortError" });
      const server = fixture.server;
      let settled = false;
      closing = fixture.close().finally(() => {
        settled = true;
      });
      closing.catch(() => {});
      await delay(150);
      assert.equal(
        settled,
        false,
        "shutdown retains admitted document creation",
      );
      assert.equal(server.child.exitCode, null);
      const retained = await sql.unsafe(
        "SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))",
        [blocked[0].pid, holder],
      );
      assert.equal(
        retained.length,
        1,
        "same admitted INSERT survives caller disconnect and shutdown",
      );
      await held.unsafe("COMMIT");
      held.release();
      held = undefined;
      await closing;
      closing = undefined;
      const rows = await sql.unsafe(
        "SELECT id,project_id,worker_id,worktree_id,protected_state FROM file_documents WHERE id=$1",
        [input.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].project_id, "github");
      assert.equal(rows[0].worker_id, "alpha");
      assert.equal(rows[0].worktree_id, input.worktreeId);
      assert.deepEqual(rows[0].protected_state, input.stateProtection);
      result.persisted = rows;
      result.callerDisconnected = true;
      result.shutdownWaitedForCommit = true;
      result.serverEvents = server.events;
      await fixture.start();
      const document = await visit(
        "committed abandoned document survives restart",
        "GET",
        "/api/file-documents/" + input.id,
      );
      assert.equal(document.id, input.id);
      assert.deepEqual(document.stateProtection, input.stateProtection);
      result.passed = true;
    } finally {
      abort.abort();
      if (held) {
        await held.unsafe("ROLLBACK");
        held.release();
      }
      await repository?.close();
      await Promise.allSettled([closing, pending]);
      await fixture.close();
      await sql.end({ timeout: 5 });
    }
  }
  assert.deepEqual(report.runtimes[1].persisted, report.runtimes[0].persisted);
  assert.deepEqual(
    report.runtimes[1].observations,
    report.runtimes[0].observations,
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.fixtureRoot = root;
} finally {
  await pg?.close();
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    runtimes: report.runtimes.map(({ kind, passed }) => ({ kind, passed })),
  }),
);
