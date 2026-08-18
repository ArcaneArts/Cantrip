import type { TelemetryQuotaReading } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { prepareProviderTelemetryChart } from "./provider-telemetry-chart";

function reading(index: number, accountId = "account"): TelemetryQuotaReading {
  return {
    id: `reading-${index}`,
    providerId: "provider",
    providerName: "Provider",
    providerAccountId: accountId,
    providerAccountLabel: accountId,
    limitName: "Weekly",
    windowKind: "secondary",
    usedPercent: index % 100,
    remainingPercent: 100 - (index % 100),
    resetsAt: null,
    observedAt: new Date(index * 60_000).toISOString(),
  };
}

describe("provider telemetry chart preparation", () => {
  it("groups large histories in bounded series and preserves endpoints", () => {
    const readings = Array.from({ length: 50_000 }, (_, index) =>
      reading(index),
    );

    const [series] = prepareProviderTelemetryChart(readings, 800);

    expect(series?.points).toHaveLength(800);
    expect(series?.points[0]?.reading).toBe(readings[0]);
    expect(series?.points.at(-1)?.reading).toBe(readings.at(-1));
  });

  it("keeps accounts separate and ignores invalid timestamps", () => {
    const invalid = { ...reading(1), observedAt: "invalid" };
    const series = prepareProviderTelemetryChart(
      [reading(0, "first"), invalid, reading(2, "second")],
      800,
    );

    expect(series.map(({ accountId }) => accountId)).toEqual([
      "first",
      "second",
    ]);
    expect(series.every(({ points }) => points.length === 1)).toBe(true);
  });
});
