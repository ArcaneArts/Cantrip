import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");

export async function receiptReadLock(databaseUrl, view = "receipt") {
  const blocker = postgres(databaseUrl, { max: 1 }),
    observer = postgres(databaseUrl, { max: 1 });
  let acquired, failed, release;
  const ready = new Promise((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const holding = blocker.begin(async (tx) => {
    await tx`LOCK TABLE managed_queue_claims IN ACCESS EXCLUSIVE MODE`;
    acquired();
    await released;
  });
  holding.catch(failed);
  await ready;
  const waiters = () =>
    observer`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query ILIKE 'select %' AND query ILIKE '%from %managed_queue_claims%' AND query NOT ILIKE '% join %' AND (query ILIKE '%order by%')=${view === "mutation"}`;
  return {
    async waiting() {
      const end = Date.now() + 15000;
      let rows;
      do {
        rows = await waiters();
        if (rows.length === 1) return rows;
        await sleep(20);
      } while (Date.now() < end);
      assert.equal(
        rows.length,
        1,
        "one actual queue " + view + " SQL read is blocked",
      );
      return rows;
    },
    waiters,
    async release() {
      release();
      await holding;
    },
    async close() {
      release();
      await holding.catch(() => {});
      await Promise.all([
        blocker.end({ timeout: 5 }),
        observer.end({ timeout: 5 }),
      ]);
    },
  };
}
