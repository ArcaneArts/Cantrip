// The actual DELETE must remain admitted after the client closes and commit
// before process shutdown. A held PostgreSQL lock proves where it is waiting.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export async function telemetryDeleteShutdown(
  fixture,
  owner,
  provider,
  report,
) {
  const observer = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const locker = postgres(fixture.environment.DATABASE_URL, { max: 1 });
  const held = deferred(),
    release = deferred();
  let transaction, caller, closing, shutdownFailure, lockerPid;
  try {
    await observer`INSERT INTO provider_quota_observations(id,owner_id,event_key,observation_batch_key,provider_id,provider_kind,provider_account_id,observed_at,used_percent_micros,window_kind,observation_trigger) VALUES('shutdown-quota',${owner},'shutdown-event','batch',${provider},'openai-compatible','telemetry-account',now(),1000000,'weekly','shutdown-fixture')`;
    await observer`INSERT INTO token_usage_records(id,owner_id,source_key,provider_id) VALUES('shutdown-token',${owner},'shutdown-token',${provider})`;
    await observer`INSERT INTO model_behavior_observations(id,owner_id,source_key,execution_attempt_id,provider_id,started_at) VALUES('shutdown-behavior',${owner},'shutdown-behavior','attempt',${provider},now())`;
    await observer`INSERT INTO provider_model_catalog_snapshots(id,owner_id,provider_id,availability_scope,metadata_source,metadata_hash,observed_at) VALUES('shutdown-catalog',${owner},${provider},'scope','fixture','hash',now())`;
    const counts = async () => {
      const result =
        await observer`SELECT (SELECT count(*)::int FROM provider_quota_observations WHERE owner_id=${owner} AND provider_id=${provider}) AS quota,(SELECT count(*)::int FROM token_usage_records WHERE owner_id=${owner} AND provider_id=${provider}) AS tokens,(SELECT count(*)::int FROM model_behavior_observations WHERE owner_id=${owner} AND provider_id=${provider}) AS behavior,(SELECT count(*)::int FROM provider_model_catalog_snapshots WHERE owner_id=${owner} AND provider_id=${provider}) AS catalog`;
      return { ...result[0] };
    };
    assert.deepEqual(await counts(), {
      quota: 1,
      tokens: 1,
      behavior: 1,
      catalog: 1,
    });
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
      await sql`LOCK TABLE provider_quota_observations IN ACCESS EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const client = fixture.client();
    const outcome = new Promise((resolve) => {
      caller = httpRequest(
        fixture.server.origin + "/api/analytics/provider-telemetry/" + provider,
        {
          method: "DELETE",
          headers: {
            origin: "http://127.0.0.1:5173",
            connection: "close",
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
      caller.end();
    });
    const expires = Date.now() + 15000;
    let blocked;
    do {
      blocked =
        await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%delete%provider_quota_observations%'`;
      if (blocked.length) break;
      assert.ok(
        Date.now() < expires,
        "observe the actual admitted DELETE blocked by our lock",
      );
      await delay(10);
    } while (true);
    const disconnected = new Error("intentional telemetry caller disconnect");
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
    assert.equal(settled, false, "shutdown waits for admitted deletion");
    const retained =
      await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%delete%provider_quota_observations%'`;
    assert.equal(
      retained.length,
      1,
      "actual DELETE survives caller closure and shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const after = await counts();
    assert.deepEqual(
      after,
      { quota: 0, tokens: 0, behavior: 0, catalog: 0 },
      "all four admitted deletes commit before exit",
    );
    Object.assign(report, {
      blockedDeleteObserved: true,
      callerDisconnected: true,
      shutdownWaitedForDatabaseRelease: true,
      committedDeletes: 4,
      remaining: after,
      passed: true,
    });
  } catch (error) {
    report.failure = { message: error.message };
    try {
      report.failure.activity =
        await observer`SELECT pid,state,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database()`;
    } catch (diagnostic) {
      report.failure.activityError = String(diagnostic);
    }
    throw error;
  } finally {
    caller?.destroy();
    release.resolve();
    const cleanup = await Promise.allSettled([transaction, closing]);
    await Promise.all([
      observer.end({ timeout: 5 }),
      locker.end({ timeout: 5 }),
    ]);
    const failed = cleanup.find((r) => r.status === "rejected");
    if (failed && !report.failure) throw failed.reason;
  }
}
