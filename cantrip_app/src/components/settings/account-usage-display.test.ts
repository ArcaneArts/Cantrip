import { accountResourceUsageHistorySchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  accountUsageHistoryWindow,
  bandwidthHistoryChartSeries,
  formatUsageBytes,
  storageHistoryChartSeries,
} from "./account-usage-display";

describe("account usage display", () => {
  it("formats exact decimal counters without converting them to unsafe numbers", () => {
    expect(formatUsageBytes("0")).toBe("0 B");
    expect(formatUsageBytes("1024")).toBe("1 KiB");
    expect(formatUsageBytes("1536")).toBe("1.5 KiB");
    expect(formatUsageBytes("9223372036854775807")).toBe("8 EiB");
  });

  it("builds bounded UTC windows at the requested resolution", () => {
    const now = new Date("2026-08-23T12:34:56.000Z");
    expect(accountUsageHistoryWindow("24h", now)).toEqual({
      from: "2026-08-22T13:00:00.000Z",
      resolution: "hour",
      to: "2026-08-23T13:00:00.000Z",
    });
    expect(accountUsageHistoryWindow("30d", now)).toEqual({
      from: "2026-07-25T00:00:00.000Z",
      resolution: "day",
      to: "2026-08-24T00:00:00.000Z",
    });
  });

  it("aggregates storage categories into separate server and worker chart lines", () => {
    const history = accountResourceUsageHistorySchema.parse({
      metric: "storage",
      resolution: "day",
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      status: "current",
      series: [
        {
          storageClass: "server",
          category: "conversations",
          accuracy: "logical-reconciled",
          points: [
            {
              bucketStart: "2026-08-20T00:00:00.000Z",
              logicalBytes: "100",
              rowCount: "2",
            },
          ],
        },
        {
          storageClass: "server",
          category: "projects",
          accuracy: "logical-reconciled",
          points: [
            {
              bucketStart: "2026-08-20T00:00:00.000Z",
              logicalBytes: "50",
              rowCount: "1",
            },
          ],
        },
        {
          storageClass: "worker-managed",
          category: "attachments",
          accuracy: "server-known-estimate",
          points: [
            {
              bucketStart: "2026-08-20T00:00:00.000Z",
              logicalBytes: "25",
              rowCount: "1",
            },
          ],
        },
      ],
      limits: null,
      enforcement: "disabled",
    });

    expect(
      storageHistoryChartSeries(history).map(({ id, points }) => [
        id,
        points[0]?.value,
      ]),
    ).toEqual([
      ["server", 150n],
      ["worker-managed", 25n],
    ]);
  });

  it("aggregates bandwidth channels by direction without losing bigint precision", () => {
    const history = accountResourceUsageHistorySchema.parse({
      metric: "bandwidth",
      resolution: "hour",
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-20T02:00:00.000Z",
      status: "current",
      series: [
        {
          channel: "http",
          direction: "ingress",
          accuracy: "metered",
          points: [
            {
              bucketStart: "2026-08-20T00:00:00.000Z",
              bytes: "9223372036854775000",
              operationCount: "1",
            },
          ],
        },
        {
          channel: "terminal-relay",
          direction: "ingress",
          accuracy: "metered",
          points: [
            {
              bucketStart: "2026-08-20T00:00:00.000Z",
              bytes: "7",
              operationCount: "1",
            },
          ],
        },
      ],
      limits: null,
      enforcement: "disabled",
    });

    expect(bandwidthHistoryChartSeries(history)[0]?.points[0]?.value).toBe(
      9_223_372_036_854_775_007n,
    );
  });
});
