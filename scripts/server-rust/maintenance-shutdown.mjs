// Real PostgreSQL locks prove retention after caller disconnect and after a
// fail-fast sibling rejects. No query or worker implementation is replaced.
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
export async function terminalMaintenanceShutdown(
  fixture,
  input,
  report,
  { disconnectCaller, stopWorker },
) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 }),
    locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const held = deferred(),
    release = deferred(),
    controller = new AbortController();
  let transaction,
    closing,
    pending,
    lockerPid,
    shutdownFailure,
    trigger = false;
  try {
    await observer`UPDATE terminals SET status='idle' WHERE id IN ('terminal','�')`;
    if (!disconnectCaller) {
      await observer.unsafe(
        `CREATE FUNCTION cantrip_test_terminal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='terminal' AND NEW.status='running' THEN RAISE EXCEPTION 'Controlled terminal status rejection'; END IF; RETURN NEW; END $$`,
      );
      await observer.unsafe(
        `CREATE TRIGGER cantrip_test_terminal_failure BEFORE UPDATE ON terminals FOR EACH ROW EXECUTE FUNCTION cantrip_test_terminal_failure()`,
      );
      trigger = true;
    }
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
      if (disconnectCaller) await sql`LOCK TABLE terminals IN SHARE MODE`;
      else await sql`SELECT id FROM terminals WHERE id='�' FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const client = fixture.client();
    pending = fetch(
      fixture.server.origin + "/api/workers/alpha/encryption/refresh",
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
    ).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    // Attach an observer immediately, so an intentional abort cannot become an
    // unhandled rejection while pg_stat_activity is being read.
    pending.catch(() => {});
    const deadline = Date.now() + 15000;
    let blocked;
    do {
      blocked =
        await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%update%terminals%'`;
      if (blocked.length) break;
      assert.ok(
        Date.now() < deadline,
        "observe actual blocked terminal status UPDATE",
      );
      await delay(10);
    } while (true);
    report.blockedUpdates = blocked;
    if (disconnectCaller) {
      const reason = new Error(
        "intentional encryption refresh caller disconnect",
      );
      controller.abort(reason);
      assert.equal(await pending.catch((error) => error), reason);
      report.callerDisconnected = true;
    } else {
      const result = await Promise.race([
        pending,
        delay(3000).then(() => {
          throw new Error(
            "a failed sibling must return HTTP before the held sibling commits",
          );
        }),
      ]);
      report.response = result;
      assert.equal(result.status, 502);
      assert.match(
        result.body.error,
        /^Failed query: update "terminals" set "status"/,
      );
      assert.match(result.body.error, /params: running,\d{4}-[^,]+,terminal$/);
      report.failedSiblingReturnedBeforeRelease = true;
    }
    report.serverEvents = fixture.server.events;
    stopWorker();
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
    assert.equal(
      settled,
      false,
      "shutdown retains unfinished terminal status writes",
    );
    const retained =
      await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%update%terminals%'`;
    assert.equal(
      retained.length,
      1,
      "the same UPDATE survives caller completion and shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const rows = await observer`SELECT id,status FROM terminals ORDER BY id`;
    report.persisted = rows;
    assert.equal(rows.find((r) => r.id === "�").status, "running");
    assert.equal(
      rows.find((r) => r.id === "terminal").status,
      disconnectCaller ? "running" : "idle",
    );
    assert.equal(rows.find((r) => r.id === "other-terminal").status, "idle");
    Object.assign(report, { shutdownWaitedForRelease: true, passed: true });
  } catch (error) {
    report.failure = { message: error.message };
    throw error;
  } finally {
    controller.abort();
    release.resolve();
    const cleanup = await Promise.allSettled([transaction, closing, pending]);
    if (trigger)
      await observer.unsafe(
        "DROP TRIGGER cantrip_test_terminal_failure ON terminals; DROP FUNCTION cantrip_test_terminal_failure()",
      );
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const failed = cleanup
      .slice(0, 2)
      .find((result) => result.status === "rejected");
    if (failed && !report.failure) throw failed.reason;
  }
}
