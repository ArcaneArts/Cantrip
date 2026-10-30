import {
  accountBandwidthPeriod,
  buildAccountResourceUsage,
  buildStorageUsageHistory,
  buildBandwidthUsageHistory,
} from "../../cantrip_server/src/account-usage/resource-usage-response.ts";
const at = "2026-10-25T00:00:00.000Z";
const row = (category, storageClass, logicalBytes, extra = {}) => ({
  ownerId: "owner",
  category,
  storageClass,
  logicalBytes: String(logicalBytes),
  rowCount: "2",
  basisVersion: "basis-one",
  measuredAt: at,
  reconciledAt: at,
  ...extra,
});
const bandwidth = (channel, direction, bytes, extra = {}) => ({
  bucketStart: at,
  updatedAt: at,
  channel,
  direction,
  bytes: String(bytes),
  operationCount: "3",
  ...extra,
});
const rows = [
  row("projects", "server", 9007199254740993n),
  row("account", "server", 12),
  row("attachments", "worker-managed", 100),
  row("attachment-replicas", "worker-managed", 200),
];
const bands = [
  bandwidth("http", "ingress", 9007199254740993n),
  bandwidth("client-live-websocket", "egress", 10),
  bandwidth("other", "ingress", 20),
];
const query = {
  metric: "storage",
  resolution: "hour",
  from: "2026-10-24T01:00:00Z",
  to: "2026-10-26T03:00:00.1234Z",
};
const cases = [];
const add = (op, input) => cases.push({ op, ...input });
for (const now of [
  at,
  "2026-10-25T02:00:00.000Z",
  "2026-10-25T02:00:00.001Z",
  "2026-10-24T00:00:00.000Z",
  "0000-02-29T10:15:23.123Z",
  "0099-12-31T23:59:59.999Z",
  "+010000-01-01T00:00:00.000Z",
]) {
  for (const storage of [
    [],
    rows,
    [...rows].reverse(),
    [...rows, row("attachments", "worker-managed", 999)],
    rows.map((r, i) => ({
      ...r,
      measuredAt: new Date(Date.parse(at) + i * 1000).toISOString(),
      reconciledAt: new Date(Date.parse(at) - i * 1000).toISOString(),
    })),
  ])
    add("current", { now, rows: storage, bandwidth: bands });
  add("period", { now });
}
for (const resolution of ["hour", "day"]) {
  for (const storage of [
    [],
    rows,
    [...rows].reverse(),
    [
      ...rows,
      ...rows.map((r) => ({
        ...r,
        bucketStart: "2026-10-25T01:00:00Z",
        logicalBytes: "123456789012345678901234567890",
      })),
    ],
  ])
    add("storage", {
      query: { ...query, resolution },
      rows: storage.map((r) => ({ ...r, bucketStart: r.bucketStart ?? at })),
    });
  for (const values of [
    [],
    bands,
    [...bands].reverse(),
    [
      ...bands,
      ...bands.map((r) => ({
        ...r,
        bucketStart: "2026-10-25T01:00:00Z",
        bytes: "123456789012345678901234567890",
      })),
    ],
  ])
    add("bandwidth", {
      query: { ...query, metric: "bandwidth", resolution },
      rows: values,
    });
}
function revive(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        ["logicalBytes", "rowCount", "bytes", "operationCount"].includes(key)
          ? BigInt(value)
          : ["measuredAt", "reconciledAt", "updatedAt", "bucketStart"].includes(
                key,
              )
            ? new Date(value)
            : value,
      ]),
    ),
  );
}
let id = 0;
for (const scenario of cases) {
  let outcome;
  if (scenario.op === "current")
    outcome = buildAccountResourceUsage(
      revive(scenario.rows),
      revive(scenario.bandwidth),
      new Date(scenario.now),
    );
  else if (scenario.op === "period") {
    const { start, end } = accountBandwidthPeriod(new Date(scenario.now));
    outcome = { start: start.getTime(), end: end.getTime() };
  } else if (scenario.op === "storage")
    outcome = buildStorageUsageHistory(scenario.query, revive(scenario.rows));
  else
    outcome = buildBandwidthUsageHistory(scenario.query, revive(scenario.rows));
  process.stdout.write(JSON.stringify({ id: id++, scenario, outcome }) + "\n");
}
process.stdout.write(JSON.stringify({ done: id }) + "\n");
