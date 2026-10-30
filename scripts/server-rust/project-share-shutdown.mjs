// The actual protected-tunnel INSERT is blocked after the worker's successful
// reply. Its HTTP caller disconnects and graceful shutdown starts before commit.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { AttachmentFixture } from "./tunnel-attachment-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { targetStateSql } from "./project-target-state.mjs";
import { shareWorker } from "./project-share-http-worker.mjs";
import { input } from "./project-share-http-cases.mjs";
import { eventually } from "./full-worker.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = await mkdtemp(path.join(tmpdir(), "cantrip-share-shutdown-"));
const reportPath = option("--report");
const report = {
  suite: "project-share-post-worker-ack-shutdown",
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
    const fixture = new AttachmentFixture({
      kind,
      executable,
      root,
      name: "shutdown",
      databaseMode: "postgres",
      environment: { DATABASE_URL: databaseUrl },
    });
    const r = { kind, commands: [], observations: [], passed: false };
    report.runtimes.push(r);
    let repo, worker, held, closing, pending;
    const sql = postgres(databaseUrl, { max: 2 }),
      abort = new AbortController();
    const visit = async (name, method, url, options = {}) => {
      const observed = await fixture.observe(name, method, url, options);
      r.observations.push({ name, ...observed });
      return fixture.records.get(name);
    };
    try {
      await fixture.start();
      await visit("session", "GET", "/api/auth/session");
      await fixture.close();
      repo = await repositoryFixture({
        kind,
        executable: repositoryBinary,
        root: path.join(root, fixture.name),
        databaseMode: "postgres",
        databaseUrl,
      });
      for (const statement of targetStateSql()) await repo.seed(statement);
      await repo.close();
      repo = undefined;
      await fixture.start();
      worker = await shareWorker({
        fixture,
        root: path.join(root, kind, "worker"),
        visit,
        result: r,
      });
      held = await sql.reserve();
      await held.unsafe("BEGIN");
      const holder = (await held.unsafe("SELECT pg_backend_pid() pid"))[0].pid;
      await held.unsafe("LOCK TABLE tunnels IN SHARE MODE");
      const body = input(14);
      pending = fetch(
        fixture.server.origin + "/api/projects/github/network-shares",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        },
      ).then(
        (response) => ({ status: response.status }),
        (error) => error,
      );
      const blocked = await eventually(
        () =>
          sql.unsafe(
            "SELECT pid,query,wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%tunnels%'",
            [holder],
          ),
        (rows) =>
          assert.equal(
            rows.length,
            1,
            "actual managed tunnel INSERT waiting after worker ACK",
          ),
      );
      r.blocked = { holder, rows: blocked };
      assert.equal(blocked[0].wait_event_type, "Lock");
      assert.ok(
        r.commands.some(
          (c) =>
            c.command.type === "project.share.open" &&
            c.command.shareId === body.tunnelId,
        ),
      );
      abort.abort();
      assert.equal((await pending).name, "AbortError");
      await worker.close();
      worker = undefined;
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
        "shutdown retains the admitted registration",
      );
      assert.equal(server.child.exitCode, null);
      const retained = await sql.unsafe(
        "SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))",
        [blocked[0].pid, holder],
      );
      assert.equal(
        retained.length,
        1,
        "same blocked query survives caller disconnect and shutdown",
      );
      await held.unsafe("COMMIT");
      held.release();
      held = undefined;
      await closing;
      closing = undefined;
      const rows = await sql.unsafe(
        "SELECT id,origin,management,managed_by_kind,managed_by_id,protected_operation_id,protected_revision,protected_content FROM tunnels WHERE id=$1",
        [body.tunnelId],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].protected_revision, 1);
      assert.deepEqual(
        rows[0].protected_content,
        body.protectedRecord.protectedContent,
      );
      r.persisted = rows;
      r.serverEvents = server.events;
      r.callerDisconnected = true;
      r.shutdownWaitedForRelease = true;
      r.passed = true;
    } finally {
      abort.abort();
      if (held) {
        await held.unsafe("ROLLBACK");
        held.release();
      }
      await worker?.close();
      await repo?.close();
      await Promise.allSettled([closing, pending]);
      await fixture.close();
      await sql.end({ timeout: 5 });
    }
  }
  assert.deepEqual(report.runtimes[1].persisted, report.runtimes[0].persisted);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (failure) report.fixtureRoot = root;
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    suite: report.suite,
    runtimes: report.runtimes.map(({ kind, passed }) => ({ kind, passed })),
    failure: report.failure ?? null,
  }),
);
if (failure) throw failure;
