// Execute the actual reference services and shared logger. Controlled repository
// replies isolate producer semantics; production database acceptance is separate.
import {
  createServiceLogger,
  minimizeServiceLogRecordInput,
} from "../../packages/logging/dist/index.js";
import { StorageReconciliationService } from "../../tests/reference-node-server/src/account-usage/storage-reconciler.ts";
import { AccountUsageHistoryMaintenanceService } from "../../tests/reference-node-server/src/account-usage/history-maintenance.ts";
import { AccountUsageMeter } from "../../tests/reference-node-server/src/account-usage/bandwidth-meter.ts";

const base = 1793059200123;
const cases = [];
for (const name of ["storage-reconciliation", "history-maintenance"])
  cases.push({
    kind: "job",
    name,
    steps: [
      { duration: 7, acquired: true },
      { duration: 3, acquired: false },
      { duration: 11, fail: true },
      { duration: 5, acquired: true, followupDuration: 13, followupFail: true },
      {
        duration: 2,
        acquired: false,
        followupDuration: 17,
        followupFail: true,
      },
      { duration: 19, acquired: true },
      { close: true },
      { duration: 5, acquired: true },
    ],
  });
const record = (owner = "owner", notifyChange = true) => ({
  op: "record",
  owner,
  notifyChange,
});
cases.push({
  kind: "meter",
  maxEntries: 1,
  observerFail: true,
  publicationFail: true,
  steps: [
    record(),
    ...Array.from({ length: 26 }, () => record("other")),
    { op: "flush", duration: 7, fail: true },
    { op: "flush", duration: 3, applied: false },
    record(),
    { op: "flush", duration: 5 },
    { op: "advance", duration: 30000 },
    record(),
    { op: "flush", duration: 2 },
    { op: "close" },
    record(),
  ],
});
cases.push({
  kind: "meter",
  maxEntries: 2,
  steps: [
    record("owner", false),
    record("other"),
    ...Array.from({ length: 27 }, (_, i) => ({
      op: "flush",
      duration: i % 4,
      fail: true,
    })),
    { op: "advance", duration: 30000 },
    { op: "flush", duration: 9, fail: true },
    { op: "flush", duration: 5 },
    record(),
    { op: "flush", duration: 1 },
    { op: "flush", duration: 3 },
    { op: "close" },
  ],
});
const json = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
const storage = (acquired) => ({
  acquired,
  accountCount: 2,
  categoryCount: 3,
  logicalBytes: 9007199254740993n,
  rowCount: 10n,
  measuredAt: new Date(base),
  ownerIds: ["owner"],
});
const history = (acquired) => ({
  acquired,
  bandwidthDaysRolled: 2,
  bandwidthHourlyRowsDeleted: 3,
  bandwidthDailyRowsDeleted: 5,
  flushRowsDeleted: 7,
  storageDaysRolled: 11,
  storageHourlyRowsDeleted: 13,
  storageDailyRowsDeleted: 17,
});
const totals = {
  accountCount: 2,
  logicalServerBytes: 19n,
  logicalWorkerManagedBytes: 23n,
  physicalDatabaseBytes: 29n,
};
const originalNow = Date.now;
try {
  for (const scenario of cases) {
    let clock = base,
      active,
      records = [];
    const trace = [];
    Date.now = () => clock;
    const logger = createServiceLogger("server", {
      now: () => new Date(clock),
      output: () => {},
      onRecord: (record) => {
        records.push(record);
        trace.push({ event: record.context.event });
      },
    });
    const fail = () => {
      throw new Error("private-accounting-error-marker");
    };
    const snapshot = (result) => ({
      result: json(result),
      stats: json(service.stats()),
      trace: trace.splice(0),
      records: json(records),
      persisted: records.map(minimizeServiceLogRecordInput),
    });
    let service;
    if (scenario.kind === "job") {
      const repository = {
        async reconcileStorage() {
          trace.push({ operation: "repository" });
          clock += active.duration;
          if (active.fail) fail();
          return storage(active.acquired);
        },
        async maintainUsageHistory() {
          trace.push({ operation: "repository" });
          clock += active.duration;
          if (active.fail) fail();
          return history(active.acquired);
        },
        async getOperationalTotals() {
          trace.push({ operation: "followup" });
          clock += active.followupDuration ?? 0;
          if (active.followupFail) fail();
          return totals;
        },
      };
      service =
        scenario.name === "storage-reconciliation"
          ? new StorageReconciliationService(repository, "holder", logger, {
              now: () => new Date(clock),
              onReconciled() {
                trace.push({ operation: "followup" });
                clock += active.followupDuration ?? 0;
                if (active.followupFail) fail();
              },
            })
          : new AccountUsageHistoryMaintenanceService(
              repository,
              "holder",
              logger,
              {
                now: () => new Date(clock),
                hourlyRetentionDays: 2,
                dailyRetentionDays: 3,
                flushRetentionDays: 1,
              },
            );
      for (const step of scenario.steps) {
        active = step;
        records = [];
        const result = step.close
          ? (await service.close(), null)
          : await (scenario.name === "storage-reconciliation"
              ? service.reconcile()
              : service.run());
        step.expected = snapshot(result);
      }
    } else {
      service = new AccountUsageMeter(
        {
          async flushBandwidthBatch(batch) {
            trace.push({ batch: json(batch) });
            clock += active.duration ?? 0;
            if (active.fail) fail();
            return {
              applied: active.applied ?? true,
              ownerIds: ["owner", "other"],
            };
          },
        },
        logger,
        {
          meterId: "diagnostic-meter",
          maxBufferedEntries: scenario.maxEntries,
          flushThresholdBytes: 1000000,
          flushIntervalMs: 60000,
          now: () => new Date(clock),
          onMeasurement(value) {
            trace.push({ measurement: json(value) });
            if (scenario.observerFail) fail();
          },
          onFlushed(owners) {
            trace.push({ owners });
            if (scenario.publicationFail) fail();
          },
        },
      );
      for (const step of scenario.steps) {
        active = step;
        records = [];
        let result = null;
        if (step.op === "record")
          result = service.record({
            ownerId: step.owner,
            bytes: 7n,
            operationCount: 1n,
            channel: "http",
            direction: "egress",
            notifyChange: step.notifyChange,
          });
        else if (step.op === "flush") result = await service.flush();
        else if (step.op === "advance") clock += step.duration;
        else await service.close();
        step.expected = snapshot(result);
      }
      await service.close();
    }
  }
} finally {
  Date.now = originalNow;
}
process.stdout.write(JSON.stringify(cases));
