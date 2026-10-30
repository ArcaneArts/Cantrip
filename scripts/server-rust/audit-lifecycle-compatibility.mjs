// Real PostgreSQL locks and rejected INSERTs exercise response timing and the
// production shutdown drain. Ordinary security comparisons cover all stores.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { auditRows, eventually } from "./audit-observations.mjs";

const requireServer = createRequire(
  path.join(repositoryRoot, "cantrip_server/package.json"),
);
const { default: postgres } = await import(
  pathToFileURL(requireServer.resolve("postgres")).href
);
const i = process.argv.indexOf("--report");
const reportPath = i < 0 ? undefined : process.argv[i + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-audit-lifecycle-"));
const report = {
  suite: "actual-audit-response-lifecycle",
  completeReplacement: false,
  databaseMode: "postgres",
  runtimes: [],
};
let owner, failure;
try {
  const executable = await buildRustServer();
  owner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const url = await owner.database();
    const fixture = new HttpFixture({
      kind,
      executable,
      root,
      name: "audit-lifecycle",
      databaseMode: "postgres",
      environment: { DATABASE_URL: url },
      auditObservations: true,
    });
    const sql = postgres(url, { max: 3 });
    const result = { kind, responses: [] };
    report.runtimes.push(result);
    let transaction, release;
    const call = async (label) => {
      const response = await fetch(
        `${fixture.server.origin}/api/encryption/principals`,
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      const body = await response.json();
      const requestId = response.headers.get("x-request-id");
      fixture.requests.set(requestId, label);
      assert.equal(response.status, 400);
      result.responses.push({
        label,
        status: response.status,
        body: fixture.normalize(body),
        contentType: response.headers.get("content-type"),
      });
      return requestId;
    };
    try {
      await fixture.start();
      let locked;
      const ready = new Promise((resolve) => {
        locked = resolve;
      });
      const hold = new Promise((resolve) => {
        release = resolve;
      });
      transaction = sql.begin(async (tx) => {
        await tx.unsafe("LOCK TABLE audit_events IN SHARE MODE");
        locked();
        await hold;
      });
      await ready;
      const request = call("locked mutation");
      const blocked = await eventually(
        async () => {
          const [row] =
            await sql`SELECT pid,query,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%audit_events%'`;
          return row;
        },
        (row) => {
          assert.ok(row);
          assert.match(row.query, /insert into.*audit_events/iu);
        },
      );
      const responseDeadline = new AbortController();
      const requestId = await Promise.race([
        request,
        delay(15000, undefined, { signal: responseDeadline.signal }).then(
          () => {
            throw new Error(
              `${kind} response waited for the blocked audit INSERT`,
            );
          },
        ),
      ]).finally(() => responseDeadline.abort());
      result.blockedAudit = {
        query: blocked.query,
        waitEventType: blocked.wait_event_type,
        responseCompletedWhileBlocked: true,
      };
      const [{ count: before }] =
        await sql`SELECT count(*)::int AS count FROM audit_events WHERE request_id=${requestId}`;
      assert.equal(before, 0);
      const server = fixture.server;
      let closed = false;
      const closing = fixture.close({ shutdownTimeoutMs: 20000 }).then(() => {
        closed = true;
      });
      await eventually(
        () =>
          server.events.some(
            (e) =>
              e.event === "fixture.shutdown.started" ||
              e.event === "server.shutdown.started",
          ),
        (started) => assert.equal(started, true),
      );
      await delay(100);
      assert.equal(
        closed,
        false,
        "Shutdown must retain the actual pending audit",
      );
      result.shutdownWaitedForAudit = true;
      release();
      await transaction;
      transaction = undefined;
      await closing;
      const [persisted] =
        await sql`SELECT action,result,owner_id,request_id FROM audit_events WHERE request_id=${requestId}`;
      assert.equal(persisted.action, "encryption.registry-changed");
      assert.equal(persisted.result, "failed");
      assert.equal(persisted.owner_id, "00000000-0000-0000-0000-000000000001");
      await fixture.start();
      assert.equal(
        (await auditRows(fixture)).filter((row) => row.requestId === requestId)
          .length,
        1,
      );
      result.retainedAuditAfterReopen = true;
      await sql.unsafe(
        "ALTER TABLE audit_events ADD CONSTRAINT fixture_audit_failure CHECK (action <> 'encryption.registry-changed') NOT VALID",
      );
      const rejectedId = await call("rejected audit");
      await eventually(
        () =>
          fixture.server.events.find(
            (event) =>
              event.requestId === rejectedId &&
              (kind === "node"
                ? event.event === "fixture.audit.completed" &&
                  event.ok === false
                : event.event === "security.audit-write-failed"),
          ),
        (event) =>
          assert.ok(event, "Observe the actual failed audit operation"),
      );
      const [{ count: rejected }] =
        await sql`SELECT count(*)::int AS count FROM audit_events WHERE request_id=${rejectedId}`;
      assert.equal(rejected, 0);
      result.rejectedAuditPreservesResponse = true;
      await fixture.close();
      await fixture.start();
      const retained = await auditRows(fixture);
      assert.equal(
        retained.filter((row) => row.requestId === requestId).length,
        1,
      );
      assert.equal(
        retained.filter((row) => row.requestId === rejectedId).length,
        0,
      );
      result.cleanShutdownAfterRejectedAudit = true;
    } finally {
      release?.();
      await transaction;
      await fixture.close();
      await sql.end();
    }
  }
  const [reference, actual] = report.runtimes;
  assert.deepEqual(actual.responses, reference.responses);
  for (const key of [
    "shutdownWaitedForAudit",
    "retainedAuditAfterReopen",
    "rejectedAuditPreservesResponse",
    "cleanShutdownAfterRejectedAudit",
  ])
    assert.equal(actual[key], reference[key]);
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await owner?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
