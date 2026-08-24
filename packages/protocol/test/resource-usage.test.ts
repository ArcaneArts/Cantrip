import { describe, expect, it } from "vitest";

import {
  accountResourceUsageHistoryQuerySchema,
  accountResourceUsageSchema,
} from "../src/resource-usage.js";

describe("account resource usage protocol", () => {
  it("preserves exact bigint counters as decimal strings", () => {
    const parsed = accountResourceUsageSchema.parse({
      measurement: {
        basisVersion: "postgres-logical-row-bytes-v1",
        measuredAt: "2026-08-23T10:00:00.000Z",
        reconciledAt: "2026-08-23T10:00:01.000Z",
        status: "current",
      },
      storage: {
        server: {
          accuracy: "logical-reconciled",
          logicalBytes: "9223372036854775807",
          rowCount: "1",
          categories: [],
        },
        workerManaged: {
          accuracy: "server-known-estimate",
          attachmentSources: { logicalBytes: "0", objectCount: "0" },
          readyReplicas: { logicalBytes: "0", objectCount: "0" },
          logicalBytes: "0",
        },
      },
      bandwidth: {
        accuracy: "unavailable",
        periodStart: "2026-08-23T00:00:00.000Z",
        periodEnd: "2026-08-24T00:00:00.000Z",
        ingressBytes: "0",
        egressBytes: "0",
        operationCount: "0",
        breakdown: [],
      },
      limits: null,
      enforcement: "disabled",
    });
    expect(parsed.storage.server.logicalBytes).toBe("9223372036854775807");
    expect(() =>
      accountResourceUsageSchema.parse({
        ...parsed,
        storage: {
          ...parsed.storage,
          server: { ...parsed.storage.server, logicalBytes: 10 },
        },
      }),
    ).toThrow();
  });

  it("bounds and orders history windows", () => {
    expect(
      accountResourceUsageHistoryQuerySchema.safeParse({
        metric: "storage",
        resolution: "hour",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      accountResourceUsageHistoryQuerySchema.safeParse({
        metric: "storage",
        resolution: "hour",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      accountResourceUsageHistoryQuerySchema.safeParse({
        metric: "bandwidth",
        resolution: "day",
        from: "2026-08-08T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
