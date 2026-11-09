// Close the real client while PostgreSQL holds the actual ownership lookup.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { LogProbe, gate } from "./worker-log-stream-probe.mjs";
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");
export async function workerLogQueryLifetime({ f, state, visit, result }) {
  const blocker = postgres(f.environment.DATABASE_URL, { max: 1 });
  const observer = postgres(f.environment.DATABASE_URL, { max: 1 });
  const acquired = gate(),
    released = gate();
  const transaction = blocker.begin(async (sql) => {
    await sql`LOCK TABLE workers IN ACCESS EXCLUSIVE MODE`;
    acquired.resolve();
    await released.promise;
  });
  transaction.catch(() => {});
  let probe;
  const offset = state.commands.length;
  try {
    await Promise.race([
      acquired.promise,
      transaction.then(() =>
        assert.fail("Ownership lock ended before release"),
      ),
    ]);
    probe = new LogProbe(f);
    (state.probes ??= []).push(probe);
    await probe.open();
    const deadline = Date.now() + 10000;
    for (;;) {
      const rows =
        await observer`SELECT pid,query,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query ILIKE 'select%' AND query ILIKE '%workers%' AND query ILIKE '%owner_id%' AND query LIKE '%$2%'`;
      if (rows.length) {
        result.blockedWorkerLogOwnershipQueries = rows;
        break;
      }
      assert.ok(
        Date.now() < deadline,
        "Log stream reaches the actual PostgreSQL ownership lock",
      );
      await delay(20);
    }
    assert.deepEqual(await probe.close(), {
      code: 1000,
      reason: "worker log fixture close",
    });
    released.resolve();
    await transaction;
    await visit(
      "worker log query completion barrier",
      "GET",
      "/api/workers/alpha/logs",
    );
    const starts = state.commands
      .slice(offset)
      .filter((command) => command.type === "diagnostics.logs.stream.start");
    result.workerLogQueryClosedBeforeAdmission = {
      starts,
      closed: probe.closeResult,
    };
    assert.equal(
      starts.length,
      0,
      "No worker lease starts for a caller that closed while its ownership query was blocked",
    );
    result.cases.push({
      name: "actual ownership query completes after caller close without admitting a worker log lease",
      closed: probe.closeResult,
      starts: 0,
    });
  } finally {
    released.resolve();
    await transaction;
    if (probe && probe.socket.readyState < 2) probe.socket.terminate();
    if (probe) await probe.waitClosed().catch(() => {});
    await blocker.end({ timeout: 0 });
    await observer.end({ timeout: 0 });
  }
}
