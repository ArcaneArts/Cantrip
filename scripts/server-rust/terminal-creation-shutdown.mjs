// A real member INSERT remains part of the admitted terminal/layout transaction
// after its HTTP caller disconnects and graceful server shutdown begins.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export async function terminalCreationShutdown(
  fixture,
  projectId,
  input,
  report,
  stopWorker,
) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 }),
    locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const held = deferred(),
    release = deferred(),
    controller = new AbortController();
  let transaction, closing, pending, lockerPid, shutdownFailure;
  try {
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
      await sql`LOCK TABLE tab_group_members IN SHARE MODE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const client = fixture.client();
    pending = fetch(
      fixture.server.origin + `/api/projects/${projectId}/terminals`,
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          ...(client.cookies.size
            ? {
                cookie: [...client.cookies]
                  .map(([k, v]) => k + "=" + v)
                  .join("; "),
              }
            : {}),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    pending.catch(() => {});
    const end = Date.now() + 15000;
    let blocked;
    do {
      blocked =
        await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%tab_group_members%'`;
      if (blocked.length) break;
      assert.ok(Date.now() < end, "observe the actual terminal member INSERT");
      await delay(10);
    } while (true);
    report.blockedInsert = blocked;
    const reason = new Error("intentional terminal creation caller disconnect");
    controller.abort(reason);
    assert.equal(await pending.catch((error) => error), reason);
    stopWorker();
    const child = fixture.server.child;
    report.serverEvents = fixture.server.events;
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
    assert.equal(
      settled,
      false,
      "terminal creation remains owned during shutdown",
    );
    const retained =
      await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%insert%tab_group_members%'`;
    assert.equal(
      retained.length,
      1,
      "the same transaction survives its caller and shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const rows =
      await observer`SELECT t.id,t.status,m.tab_key,m.project_id,p.tab_layout_revision revision FROM terminals t JOIN tab_group_members m ON m.tab_id=t.id AND m.tab_kind='terminal' JOIN projects p ON p.id=t.project_id WHERE t.id=${input.id}`;
    report.persisted = rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tab_key, "terminal:" + input.id);
    assert.equal(rows[0].project_id, projectId);
    assert.equal(rows[0].status, "idle");
    assert.equal(rows[0].revision, 2);
    Object.assign(report, {
      callerDisconnected: true,
      shutdownWaitedForRelease: true,
      atomicTerminalAndMemberRetained: true,
      passed: true,
    });
  } catch (error) {
    report.failure = { message: error.message };
    throw error;
  } finally {
    controller.abort();
    release.resolve();
    const done = await Promise.allSettled([transaction, closing, pending]);
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const failed = done.slice(0, 2).find((v) => v.status === "rejected");
    if (failed && !report.failure) throw failed.reason;
  }
}
