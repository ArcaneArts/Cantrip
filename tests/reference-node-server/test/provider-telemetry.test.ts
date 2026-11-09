import { describe, expect, it } from "vitest";

import { sampleProviderTelemetryQuotaHistory } from "../src/models/provider-telemetry.js";

describe("provider telemetry chart sampling", () => {
  it("bounds each account while preserving its first and latest readings", () => {
    const readings = Array.from({ length: 20_000 }, (_, index) => ({
      id: `reading-${index}`,
      providerAccountId: index % 2 ? "secondary" : "primary",
    }));

    const sampled = sampleProviderTelemetryQuotaHistory(readings, 100);

    expect(sampled).toHaveLength(200);
    expect(
      sampled.filter(
        ({ providerAccountId }) => providerAccountId === "primary",
      ),
    ).toHaveLength(100);
    expect(
      sampled.filter(
        ({ providerAccountId }) => providerAccountId === "secondary",
      ),
    ).toHaveLength(100);
    expect(sampled).toContain(readings[0]);
    expect(sampled).toContain(readings[1]);
    expect(sampled).toContain(readings.at(-2));
    expect(sampled).toContain(readings.at(-1));
  });

  it("keeps small histories unchanged", () => {
    const readings = [
      { id: "first", providerAccountId: "account" },
      { id: "second", providerAccountId: "account" },
    ];

    expect(sampleProviderTelemetryQuotaHistory(readings, 100)).toEqual(
      readings,
    );
  });
});
