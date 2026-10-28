// Hold the real membership INSERT behind a table lock, disconnect its caller, and prove
// that shutdown retains admission until the durable mutation has committed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
// Observe the production executor's actual 30-second renewal while its worker
// command remains held. Both timestamps come from the same durable job row.
export async function folderLeaseRenewal(fixture, projectId, report) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const read = () =>
    observer`SELECT state,state_revision,attempt,command_id,lease_expires_at FROM project_folder_setup_jobs WHERE project_id=${projectId}`;
  try {
    const initial = (await read())[0];
    report.initial = initial;
    assert.equal(initial.state, "running");
    assert.ok(initial.command_id);
    const deadline = performance.now() + 45_000;
    let renewed;
    for (;;) {
      renewed = (await read())[0];
      report.lastObserved = renewed;
      if (
        renewed.lease_expires_at.getTime() -
          initial.lease_expires_at.getTime() >=
        20_000
      )
        break;
      assert.ok(
        performance.now() < deadline,
        "observe actual production lease renewal before the worker command timeout",
      );
      await delay(250);
    }
    assert.equal(renewed.state, "running");
    assert.equal(renewed.command_id, initial.command_id);
    assert.equal(renewed.attempt, initial.attempt);
    assert.equal(renewed.state_revision, initial.state_revision);
    report.passed = true;
  } catch (error) {
    report.failure = { message: error.message };
    throw error;
  } finally {
    await observer.end({ timeout: 5 });
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export async function folderCreationShutdown(fixture, input, report) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const held = deferred(),
    release = deferred();
  let transaction, caller, closing, shutdownFailure, lockerPid;
  try {
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
      await sql`LOCK TABLE project_workspace_memberships IN ACCESS EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const client = fixture.client();
    const body = JSON.stringify(input);
    const outcome = new Promise((resolve) => {
      caller = request(
        fixture.server.origin + "/api/projects/from-folder",
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            connection: "close",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(client.cookies.size
              ? {
                  cookie: [...client.cookies]
                    .map(([k, v]) => k + "=" + v)
                    .join("; "),
                }
              : {}),
            ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve({ status: response.statusCode }));
        },
      );
      caller.once("error", resolve);
      caller.end(body);
    });
    const expires = Date.now() + 15000;
    let blocked;
    do {
      blocked =
        await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%project_workspace_memberships%'`;
      if (blocked.length) break;
      assert.ok(
        Date.now() < expires,
        "observe the actual admitted folder membership INSERT",
      );
      await delay(10);
    } while (true);
    const disconnected = new Error("intentional folder creation disconnect");
    caller.destroy(disconnected);
    assert.equal(await outcome, disconnected);
    const child = fixture.server.child;
    let settled = false;
    closing = fixture.close().then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        shutdownFailure = error;
      },
    );
    await delay(150);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(settled, false, "shutdown waits for admitted folder creation");
    assert.equal(
      (
        await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%project_workspace_memberships%'`
      ).length,
      1,
      "folder membership INSERT survives caller closure and shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const retained =
      await observer`SELECT p.id,j.state,j.attempt,m.workspace_id FROM projects p JOIN project_folder_setup_jobs j ON j.project_id=p.id JOIN project_workspace_memberships m ON m.project_id=p.id WHERE p.id=${input.id}`;
    assert.equal(
      retained.length,
      1,
      "disconnected creation committed one project, membership and durable job",
    );
    assert.equal(retained[0].state, "queued");
    assert.equal(retained[0].attempt, 0);
    Object.assign(report, {
      blockedInsertObserved: true,
      callerDisconnected: true,
      shutdownWaitedForDatabaseRelease: true,
      retainedProjectId: retained[0].id,
      passed: true,
    });
  } catch (error) {
    report.failure = { message: error.message };
    throw error;
  } finally {
    caller?.destroy();
    release.resolve();
    const cleanup = await Promise.allSettled([transaction, closing]);
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed && !report.failure) throw failed.reason;
  }
}
