// Real production timers, PostgreSQL errors and a final flush held by a real
// relation lock. No diagnostic route or substituted repository is installed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "./postgres-fixture.mjs";
import { databaseHealthProxy } from "./database-health-proxy.mjs";
import {
  accountingProductionPeer,
  waitAccounting,
} from "./accounting-production-peer.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(path.join(tmpdir(), "cantrip-accounting-fault-"));
console.error(JSON.stringify({ root }));
const report = { root, peers: [], completeReplacement: false };
let pg, failure;
const marker = "private-accounting-error-marker";
const events = [
  "account-usage.bandwidth-flush.failed",
  "account-usage.storage-reconciliation.failed",
  "account-usage.history-maintenance.failed",
];
function normalize(record) {
  const copy = structuredClone(record);
  delete copy.timestamp;
  delete copy.cursor;
  delete copy.context.durationMs;
  return copy;
}
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  // Independent databases and processes can exercise their real minute timers
  // concurrently without sharing user work or doubling product operations.
  const outcomes = await Promise.allSettled(
    ["node", "rust"].map(async (kind) => {
      const result = { kind, phases: [] };
      report.peers.push(result);
      const url = await pg.database(),
        admin = postgres(url, { max: 1 }),
        errors = [];
      const proxy = await databaseHealthProxy(url, {
        onError: (error) => errors.push(error),
      });
      const data = path.join(root, kind);
      let peer;
      const stage = (value) => {
        result.stage = value;
        console.error(JSON.stringify({ kind, stage: value }));
      };
      try {
        const fast = {};
        result.phases.push(fast);
        peer = await accountingProductionPeer(kind, data, proxy.url, 250, fast);
        const serverId = (await peer.request("/api/bootstrap")).server.id;
        const flushComplete = peer.count("Account bandwidth usage flushed");
        const storageComplete = peer.count(
            "Account storage reconciliation completed",
          ),
          historyComplete = peer.count(
            "Account usage history maintenance completed",
          );
        await admin.unsafe(
          `CREATE FUNCTION diagnostics_accounting_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${marker}'; RETURN NEW; END $$`,
        );
        await admin.unsafe(
          "CREATE TRIGGER diagnostics_bandwidth_failure BEFORE INSERT ON account_bandwidth_flushes FOR EACH ROW EXECUTE FUNCTION diagnostics_accounting_failure()",
        );
        await admin.unsafe(
          "CREATE TRIGGER diagnostics_lease_failure BEFORE INSERT OR UPDATE ON account_storage_reconciliation_leases FOR EACH ROW EXECUTE FUNCTION diagnostics_accounting_failure()",
        );
        stage("wait for actual bandwidth failure");
        await peer.request("/api");
        await peer.waitMessage("Account bandwidth usage flush failed");
        await waitAccounting(
          () => errors.some((error) => error.code === "P0001"),
          "Actual PostgreSQL raised the controlled exception",
        );
        await admin.unsafe(
          "DROP TRIGGER diagnostics_bandwidth_failure ON account_bandwidth_flushes",
        );
        await peer.waitMessage(
          "Account bandwidth usage flushed",
          flushComplete,
        );
        assert.equal((await peer.request("/readyz")).database.status, "ready");
        stage("wait for real minute storage/history failures");
        await Promise.all([
          peer.waitMessage("Account storage reconciliation failed", 0, 75000),
          peer.waitMessage(
            "Account usage history maintenance failed",
            0,
            75000,
          ),
        ]);
        assert.ok(errors.filter((error) => error.code === "P0001").length >= 3);
        await admin.unsafe(
          "DROP TRIGGER diagnostics_lease_failure ON account_storage_reconciliation_leases",
        );
        stage("wait for real minute storage/history recovery");
        await Promise.all([
          peer.waitMessage(
            "Account storage reconciliation completed",
            storageComplete,
            75000,
          ),
          peer.waitMessage(
            "Account usage history maintenance completed",
            historyComplete,
            75000,
          ),
        ]);
        await peer.close();
        fast.records = await peer.records();
        peer = undefined;
        result.failureRecords = events.map((event) => {
          const record = fast.records.find(
            (record) => record.context?.event === event,
          );
          assert.ok(record, event);
          assert.equal(record.level, "error");
          return normalize(record);
        });
        assert.ok(
          !JSON.stringify(fast.records).includes(marker),
          "Private SQL error content is absent from persisted records",
        );
        result.actualBackendErrors = errors;
        stage("restart retained profile and hold final real flush");
        const held = {};
        result.phases.push(held);
        peer = await accountingProductionPeer(
          kind,
          data,
          proxy.url,
          60000,
          held,
        );
        assert.equal(
          (await peer.request("/api/bootstrap")).server.id,
          serverId,
        );
        await peer.request("/api");
        await peer.waitMessage("GET /api -> 200 OK (");
        const [{ pid: blocker }] = await admin`SELECT pg_backend_pid() AS pid`;
        await admin.unsafe("BEGIN");
        await admin.unsafe(
          "LOCK TABLE account_bandwidth_flushes IN ACCESS EXCLUSIVE MODE",
        );
        const [before] =
          await admin`SELECT count(*)::text AS receipts FROM account_bandwidth_flushes`;
        held.before = before;
        peer.stop();
        await peer.waitMessage("Cantrip Server shutdown began");
        const blocked = await waitAccounting(async () => {
          const rows =
            await admin`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND ${blocker}=ANY(pg_blocking_pids(pid)) AND query ILIKE '%account_bandwidth_flushes%'`;
          return rows.length ? rows : false;
        }, "Actual final flush is blocked by the owned relation lock");
        held.blocked = blocked;
        await delay(250);
        assert.equal(
          peer.child.exitCode,
          null,
          "Shutdown drains the real blocked transaction",
        );
        await admin.unsafe("COMMIT");
        await peer.close();
        held.records = (await peer.records()).slice(fast.records.length);
        peer = undefined;
        const [after] =
          await admin`SELECT count(*)::text AS receipts FROM account_bandwidth_flushes`;
        held.after = after;
        assert.equal(BigInt(after.receipts), BigInt(before.receipts) + 1n);
        assert.ok(
          held.records.some(
            (record) =>
              record.context?.event ===
              "account-usage.bandwidth-flush.completed",
          ),
        );
        assert.ok(
          held.records.some(
            (record) => record.context?.event === "server.shutdown.completed",
          ),
        );
        stage("completed");
      } finally {
        await admin.unsafe("ROLLBACK");
        await peer?.close();
        await proxy.close();
        await admin.end({ timeout: 5 });
      }
    }),
  );
  for (const outcome of outcomes)
    if (outcome.status === "rejected") throw outcome.reason;
  assert.deepEqual(
    report.peers.find((peer) => peer.kind === "rust").failureRecords,
    report.peers.find((peer) => peer.kind === "node").failureRecords,
    "Actual PostgreSQL failure records match the reference",
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, root, productionProcesses: 4 }));
