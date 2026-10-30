// Real server shutdown while already-closed workers still hold authentication
// permits. Disposable PostgreSQL triggers count committed usage writes; no
// server hook or simulated repository completion stands in for that work.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { SocketProbe } from "./worker-sockets.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export async function workerAuthenticationShutdown(
  fixture,
  locker,
  observer,
  credential,
  hash,
  report,
) {
  await observer.unsafe(`
    CREATE TABLE cantrip_test_auth_shutdown_writes(credential_id text NOT NULL);
    CREATE FUNCTION cantrip_test_auth_shutdown_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO cantrip_test_auth_shutdown_writes VALUES (NEW.id);
        RETURN NEW;
      END $$;
    CREATE TRIGGER cantrip_test_auth_shutdown
      AFTER UPDATE OF last_used_at ON worker_credentials
      FOR EACH ROW EXECUTE FUNCTION cantrip_test_auth_shutdown_write();
  `);
  const held = deferred(),
    release = deferred(),
    probes = [];
  let lockerPid;
  const transaction = locker.begin(async (sql) => {
    lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
    await sql`SELECT id FROM worker_credentials WHERE secret_hash=${hash} FOR UPDATE`;
    held.resolve();
    await release.promise;
  });
  transaction.catch(held.reject);
  let closing;
  let shutdownFailure;
  let failed;
  try {
    await held.promise;
    for (let index = 0; index < 32; index++) {
      const probe = new SocketProbe(fixture, { credential });
      probes.push(probe);
      await probe.open();
      assert.equal((await probe.message()).state, "pending");
    }
    const deadline = performance.now() + 15000;
    let blocked;
    do {
      blocked = await observer`
        SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND ${lockerPid} = ANY(pg_blocking_pids(pid))
      `;
      if (blocked.length) break;
      assert.ok(
        performance.now() < deadline,
        "Observe actual authentication lock wait",
      );
      await delay(10);
    } while (true);
    for (const probe of probes) {
      await probe.close();
      assert.ok(!probe.frames.some((frame) => frame.state === "ready"));
    }
    const child = fixture.server.child;
    let settled = false;
    closing = fixture.close().then(
      () => (settled = true),
      (error) => {
        settled = true;
        shutdownFailure = error;
      },
    );
    await delay(150);
    assert.equal(
      child.exitCode,
      null,
      "Shutdown must drain closed-socket authentication",
    );
    assert.equal(child.signalCode, null);
    assert.equal(settled, false);
    const locked = await observer`
      SELECT 1 FROM pg_locks
      WHERE pid=${lockerPid} AND locktype='transactionid' AND mode='ExclusiveLock' AND granted
    `;
    assert.ok(
      locked.length,
      "The actual credential locker must still hold its transaction",
    );
    const before =
      await observer`SELECT count(*)::int AS count FROM cantrip_test_auth_shutdown_writes`;
    assert.equal(
      before[0].count,
      0,
      "No authentication usage write may bypass the lock",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const after =
      await observer`SELECT count(*)::int AS count FROM cantrip_test_auth_shutdown_writes`;
    assert.equal(
      after[0].count,
      32,
      "Shutdown must commit every admitted authentication usage write",
    );
    Object.assign(report, {
      pendingSockets: 32,
      blockedQueryObserved: true,
      shutdownWaitedForDatabaseRelease: true,
      committedUsageWrites: after[0].count,
      passed: true,
    });
  } catch (error) {
    failed = error;
    // Keep actual activity only on failure; backend PIDs and scheduling are
    // diagnostic evidence, not values normalized into wire equality.
    report.failure = { message: error.message };
    try {
      report.failure.activity = await observer`
        SELECT pid,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      `;
    } catch (diagnosticError) {
      report.failure.activityError = diagnosticError.message;
    }
    throw error;
  } finally {
    release.resolve();
    const cleanup = await Promise.allSettled([
      transaction,
      ...probes.map((probe) => probe.close()),
      closing,
    ]);
    const cleanupErrors = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    try {
      await observer.unsafe(`
      DROP TRIGGER cantrip_test_auth_shutdown ON worker_credentials;
      DROP FUNCTION cantrip_test_auth_shutdown_write();
      DROP TABLE cantrip_test_auth_shutdown_writes;
    `);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      if (failed) {
        report.failure.cleanupErrors = cleanupErrors.map(
          (error) => error.message,
        );
      } else {
        throw new AggregateError(
          cleanupErrors,
          "Authentication shutdown fixture cleanup failed",
        );
      }
    }
    if (!failed && !shutdownFailure) await fixture.start();
  }
}
