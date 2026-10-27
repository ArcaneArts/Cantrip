const at = "2026-10-25T00:00:00.000Z";
const epoch = "11111111-1111-4111-8111-111111111111";
const end = "2026-10-26T00:00:00.000Z";
const point = {
  timestamp: at,
  uploadBytes: 123,
  downloadBytes: 456,
  httpRequests: 2,
  websocketMessages: { upload: 1, download: 2, total: 3 },
};
const common = {
  resolution: "hour",
  from: at,
  to: end,
  status: "current",
  limits: null,
  enforcement: "disabled",
};
export const usageWireFixtures = {
  accountResourceUsageSchema: [
    {
      measurement: {
        basisVersion: "fixture-basis",
        measuredAt: at,
        reconciledAt: at,
        status: "current",
      },
      storage: {
        server: {
          accuracy: "logical-reconciled",
          logicalBytes: "9007199254740993",
          rowCount: "2",
          categories: [
            {
              category: "account",
              logicalBytes: "9007199254740993",
              rowCount: "2",
            },
          ],
        },
        workerManaged: {
          accuracy: "server-known-estimate",
          logicalBytes: "12",
          attachmentSources: { logicalBytes: "10", objectCount: "1" },
          readyReplicas: { logicalBytes: "2", objectCount: "1" },
        },
      },
      bandwidth: {
        accuracy: "metered",
        measuredAt: at,
        periodStart: at,
        periodEnd: end,
        ingressBytes: "4",
        egressBytes: "5",
        operationCount: "2",
        breakdown: [
          {
            channel: "http",
            direction: "ingress",
            bytes: "4",
            operationCount: "1",
          },
        ],
      },
      limits: null,
      enforcement: "disabled",
    },
  ],
  accountResourceUsageHistoryQuerySchema: [
    { metric: "storage", resolution: "hour", from: at, to: end },
    { metric: "bandwidth", resolution: "day", from: at, to: end },
  ],
  accountResourceUsageHistorySchema: [
    {
      ...common,
      metric: "storage",
      series: [
        {
          storageClass: "server",
          category: "account",
          accuracy: "logical-reconciled",
          points: [{ bucketStart: at, logicalBytes: "123", rowCount: "2" }],
        },
      ],
    },
    {
      ...common,
      metric: "bandwidth",
      series: [
        {
          channel: "http",
          direction: "ingress",
          accuracy: "metered",
          points: [{ bucketStart: at, bytes: "123", operationCount: "2" }],
        },
      ],
    },
  ],
  accountLiveTrafficQuerySchema: [{}, { epoch, after: "123:4" }],
  accountLiveTrafficSchema: [
    {
      schemaVersion: 1,
      epoch,
      cursor: "123:4",
      instanceId: "fixture-instance",
      scope: "current-server-instance",
      sampleIntervalSeconds: 0.25,
      windowSeconds: 600,
      generatedAt: at,
      reset: false,
      current: point,
      samples: [point],
      measurement: {
        basis: "application-payload",
        directTrafficIncluded: false,
        transportOverheadIncluded: false,
      },
    },
  ],
};
export function* usageQueryCases(name) {
  if (name === "accountResourceUsageHistoryQuerySchema") {
    for (const resolution of ["hour", "day"])
      for (const duration of [
        -1,
        0,
        1,
        31 * 86400000,
        31 * 86400000 + 1,
        732 * 86400000,
        732 * 86400000 + 1,
      ]) {
        yield {
          metric: "storage",
          resolution,
          from: at,
          to: new Date(Date.parse(at) + duration).toISOString(),
        };
      }
    for (const from of [
      "invalid",
      "2026-02-30T00:00:00Z",
      "2026-01-01T00:00:00.999999999999999999999Z",
      "2026-01-01T00:00Z",
      "\ud800",
      "0000-02-29T00:00:00Z",
    ])
      yield { metric: "storage", resolution: "day", from, to: at };
  }
  if (name === "accountLiveTrafficQuerySchema") {
    for (const value of [
      { after: "1:2" },
      { epoch },
      { epoch, after: "" },
      { epoch: "", after: "1:2" },
      { epoch, after: "1:2\n" },
      { after: "bad" },
      { epoch: "bad" },
    ])
      yield value;
  }
}
