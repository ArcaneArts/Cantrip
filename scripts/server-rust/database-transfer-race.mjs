import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

// Two real CLI processes wait on the same transaction lock used by native
// startup migrations. No catalog record or limiter outcome is substituted.
export async function databaseTransferRace({
  url,
  restore,
  observe,
  expected,
}) {
  const sql = postgres(url, { max: 3 });
  const held = await sql.reserve();
  let released = false;
  const pending = [];
  try {
    await held.unsafe("BEGIN");
    await held.unsafe("SELECT pg_advisory_xact_lock(4310, 1)");
    pending.push(restore(), restore());
    for (const task of pending) task.catch(() => {});
    const deadline = Date.now() + 30000;
    let waiting;
    for (;;) {
      waiting =
        await sql`SELECT pid,wait_event_type,query,pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query='SELECT pg_advisory_xact_lock(4310, 1)' ORDER BY pid`;
      if (waiting.length === 2) break;
      assert.ok(Date.now() < deadline, JSON.stringify(waiting));
      await delay(20);
    }
    for (const row of waiting) {
      assert.equal(row.wait_event_type, "Lock");
      assert.ok(row.blockers.length);
    }
    await held.unsafe("COMMIT");
    released = true;
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
    assert.ok(results.find((r) => r.code === 1).stderr.includes("42P06"));
    const snapshot = await observe();
    assert.deepEqual(snapshot.tables, expected.tables);
    assert.deepEqual(snapshot.sequences, expected.sequences);
    return { waiting, results, snapshot };
  } finally {
    if (!released) await held.unsafe("ROLLBACK");
    held.release();
    await Promise.allSettled(pending);
    await sql.end({ timeout: 5 });
  }
}
