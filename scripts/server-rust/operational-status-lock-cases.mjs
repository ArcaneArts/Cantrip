// A real PostgreSQL relation lock proves when health samples live collectors.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function operationalHealthLockCases({
  h,
  result,
  health,
  scrape,
  prometheus,
  url,
}) {
  const blocker = postgres(url, { max: 1 });
  const observer = postgres(url, { max: 1 });
  let unlock, locked, pending, failure;
  const acquired = new Promise((resolve) => {
    locked = resolve;
  });
  const released = new Promise((resolve) => {
    unlock = resolve;
  });
  const transaction = blocker.begin(async (sql) => {
    await sql`LOCK TABLE workers IN ACCESS EXCLUSIVE MODE`;
    locked();
    await released;
  });
  transaction.catch(() => {});
  const proof = (result.healthQueryLock = {
    scope:
      "Actual external PostgreSQL relation lock, pending production health query and real Live socket close; PGlite's serialized connection is not treated as a pool.",
  });
  try {
    await Promise.race([
      acquired,
      transaction.then(() =>
        assert.fail("lock transaction ended before release"),
      ),
    ]);
    pending = health(
      "health samples actual Live state after its worker query returns",
    );
    pending.catch(() => {});
    const deadline = Date.now() + 10000;
    for (;;) {
      const rows =
        await observer`SELECT pid, query, wait_event_type, wait_event FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query ILIKE 'select%' AND query ILIKE '%workers%'`;
      if (rows.length) {
        proof.actualBlockedQueries = rows;
        break;
      }
      assert.ok(
        Date.now() < deadline,
        "production health worker query reaches actual relation lock",
      );
      await delay(20);
    }
    await h.live.close();
    const during = prometheus(
      await scrape(
        "real Live close is visible while health query remains locked",
      ),
    );
    assert.equal(during.number("cantrip_live_connections"), 0);
    unlock();
    await transaction;
    const response = await pending;
    assert.equal(
      response.live.connectionCount,
      0,
      "health must sample Live after its worker query, as Source does",
    );
    proof.liveConnectionsAfterBlockedQuery = response.live.connectionCount;
    result.cases.push({
      name: "actual worker-query lock collector ordering",
      liveConnectionsWhileLocked: during.number("cantrip_live_connections"),
      liveConnectionsAfterQuery: response.live.connectionCount,
    });
  } catch (error) {
    failure = error;
    proof.failure = { message: error.message, stack: error.stack };
  } finally {
    unlock();
    for (const operation of [transaction, pending]) {
      try {
        await operation;
      } catch (error) {
        failure ??= error;
      }
    }
    await blocker.end({ timeout: 0 });
    await observer.end({ timeout: 0 });
  }
  if (failure) throw failure;
}
