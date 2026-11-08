// Execute the actual Source collector with controlled clocks. Entire ordered
// Prometheus documents and snapshots are compared, including exact BigInt bytes.
import { OperationalMetrics } from "../../cantrip_server/src/operations/metrics.ts";
const startedAt = 1792886400000;
let now = startedAt,
  elapsed = 1000;
const ActualDate = Date;
globalThis.Date = class extends ActualDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
  static now() {
    return now;
  }
};
Object.defineProperty(performance, "now", { value: () => elapsed });
const metrics = new OperationalMetrics(),
  cases = [],
  operations = [],
  releases = new Map();
const input = {
  coordination: {
    shared: true,
    instanceCount: 2,
    maximumInstances: 7,
    sentMessages: 11,
    receivedMessages: 13,
    rejectedMessages: 17,
  },
  workers: {
    connectedWorkers: 19,
    activeRequests: 23,
    routedRequests: 29,
    failedRequests: 31,
  },
  live: {
    connectionCount: 37,
    deliveredEventCount: 41,
    protocolViolationCount: 43,
  },
  quotas: {
    relayBytes: 47,
    uploadBytes: 53,
    activeRemoteSurfaces: 59,
    rejectedRelayBandwidth: 61,
    rejectedRemoteSurfaces: 67,
    rejectedUploads: 71,
  },
  tunnels: {
    activeConnections: 73,
    activeRoutes: 79,
    openedConnections: 83,
    closedConnections: 89,
    rejectedConnections: 97,
    bytesFromSource: 101,
    bytesToSource: 103,
    terminationsByReason: { normal: 107, 'quoted"\\\n🌙': 109 },
  },
};
const encode = (value) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
const capture = () =>
  cases.push({
    startedAt,
    now,
    operations: structuredClone(operations),
    input: encode(input),
    snapshot: metrics.snapshot(),
    prometheus: metrics.renderPrometheus(input),
  });
function action(operation) {
  now += 17;
  operations.push(operation);
  switch (operation.type) {
    case "begin":
      releases.set(operation.id, metrics.beginHttpRequest());
      break;
    case "finish":
      releases.get(operation.id)();
      metrics.recordHttpResponse(
        operation.method,
        operation.status,
        elapsed - operation.durationMs,
      );
      break;
    case "probe":
      metrics.recordDatabaseProbe(operation.ready, operation.durationMs);
      break;
    case "legacy":
      metrics.recordLegacyFeatureTransport(operation.endpoint);
      break;
    case "direct":
      metrics.recordDirectTransport(operation.kind, operation.value);
      break;
    case "scheduler":
      metrics.recordSchedulerScan(operation.value);
      break;
  }
  capture();
}
capture();
action({ type: "begin", id: "held" });
for (const method of ["GET", "HEAD", "POST", "PATCH", "OPTIONS"]) {
  for (const status of [
    200, 201, 204, 302, 400, 401, 403, 404, 409, 410, 415, 429, 500, 503,
  ]) {
    const id = `${method}:${status}`;
    action({ type: "begin", id });
    action({
      type: "finish",
      id,
      method,
      status,
      durationMs: status % 2 ? -4 : 12.5,
    });
  }
}
action({
  type: "finish",
  id: "held",
  method: "get",
  status: 202,
  durationMs: 0.125,
});
for (const [ready, durationMs] of [
  [true, 17.25],
  [false, 5],
  [false, -1],
  [true, 0],
])
  action({ type: "probe", ready, durationMs });
for (const endpoint of [
  "remote-surface-transport",
  "terminal-direct",
  "terminal-relay",
  "tunnel-direct",
  "tunnel-direct-activate",
  "tunnel-relay",
])
  for (let n = 0; n < 2; n++) action({ type: "legacy", endpoint });
for (const kind of ["tunnel", "terminal", 'quoted"\\\n🌙'])
  action({
    type: "direct",
    kind,
    value: {
      bytesFromLocal: 9007199254740991,
      bytesToLocal: 7,
      connectionsOpened: 3,
      connectionsClosed: 2,
    },
  });
for (const failed of [false, true, false])
  action({
    type: "scheduler",
    value: {
      dispatchFailures: 5,
      dispatches: 7,
      dueOccurrences: 11,
      durationMs: failed ? -1 : 12.5,
      failed,
      leaseContentions: 13,
      leaseRecoveries: 17,
      maximumLagMs: failed ? 0 : 37,
    },
  });
const at = new Date(startedAt).toISOString();
input.accountUsage = {
  bandwidthMeter: {
    bufferedBytes: 123456789012345678901234567890n,
    bufferedEntries: 3,
    droppedBytes: 987654321098765432109876543210n,
    droppedMeasurements: 9007199254740993n,
    flushCount: 5,
    flushFailureCount: 7,
    lastFlushDurationMs: 12.5,
  },
  storageReconciliation: {
    completionCount: 11,
    failureCount: 13,
    leaseContentionCount: 17,
    lastDurationMs: 37,
    lastSuccessfulAt: at,
    lastResult: {
      accountCount: 19,
      categoryCount: 23,
      logicalBytes: 100000000000000000000000000001n,
      rowCount: 9007199254740993n,
    },
  },
  historyMaintenance: {
    completionCount: 29,
    failureCount: 31,
    leaseContentionCount: 37,
    lastDurationMs: 41,
    lastSuccessfulAt: at,
    lastResult: {
      bandwidthDaysRolled: 43,
      storageDaysRolled: 47,
      bandwidthHourlyRowsDeleted: 53,
      bandwidthDailyRowsDeleted: 59,
      storageHourlyRowsDeleted: 61,
      storageDailyRowsDeleted: 67,
      flushRowsDeleted: 71,
    },
    totals: {
      accountCount: 73,
      logicalServerBytes: 999999999999999999999999999999n,
      logicalWorkerManagedBytes: 9007199254740993n,
      physicalDatabaseBytes: 1n,
    },
  },
};
capture();
input.accountUsage.historyMaintenance.totals.physicalDatabaseBytes = null;
input.accountUsage.storageReconciliation.lastResult = null;
input.accountUsage.historyMaintenance.lastResult = null;
input.accountUsage.historyMaintenance.lastSuccessfulAt = new Date(
  now + 100000,
).toISOString();
input.accountUsage.storageReconciliation.lastSuccessfulAt = null;
capture();
delete input.accountUsage;
now = startedAt - 1000;
capture();
process.stdout.write(JSON.stringify(cases));
