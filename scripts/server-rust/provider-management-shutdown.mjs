// Hold the real UPDATE behind a row lock, disconnect its HTTP caller, and prove
// that shutdown retains admission until the durable mutation has committed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request } from "node:http";
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
export async function providerManagementShutdown(
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
    transaction = locker.begin(async (sql) => {
      lockerPid = (await sql`SELECT pg_backend_pid() AS pid`)[0].pid;
      assert.equal(
        (
          await sql`SELECT id FROM model_providers WHERE id=${provider} AND owner_id=${owner} FOR UPDATE`
        ).length,
        1,
      );
      held.resolve();
      await release.promise;
    });
    transaction.catch(held.reject);
    await held.promise;
    const client = fixture.client();
    const body = JSON.stringify({
      name: "shutdown retained write",
      kind: "openai-compatible",
      baseUrl: "https://example.invalid",
    });
    const outcome = new Promise((resolve) => {
      caller = request(
        fixture.server.origin + "/api/settings/providers/" + provider,
        {
          method: "PATCH",
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
        await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%update%model_providers%'`;
      if (blocked.length) break;
      assert.ok(
        Date.now() < expires,
        "observe the actual admitted provider UPDATE",
      );
      await delay(10);
    } while (true);
    const disconnected = new Error("intentional provider mutation disconnect");
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
    assert.equal(settled, false, "shutdown waits for admitted provider update");
    assert.equal(
      (
        await observer`SELECT pid FROM pg_stat_activity WHERE pid=${blocked[0].pid} AND ${lockerPid}=ANY(pg_blocking_pids(pid)) AND lower(query) LIKE '%update%model_providers%'`
      ).length,
      1,
      "provider UPDATE survives caller closure and shutdown",
    );
    release.resolve();
    await transaction;
    await closing;
    if (shutdownFailure) throw shutdownFailure;
    const retained =
      await observer`SELECT name FROM model_providers WHERE id=${provider} AND owner_id=${owner}`;
    assert.equal(retained[0].name, "shutdown retained write");
    Object.assign(report, {
      blockedUpdateObserved: true,
      callerDisconnected: true,
      shutdownWaitedForDatabaseRelease: true,
      retainedName: retained[0].name,
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
