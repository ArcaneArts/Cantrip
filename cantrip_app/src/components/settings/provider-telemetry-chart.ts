import type { TelemetryQuotaReading } from "@cantrip/protocol";

export const PROVIDER_TELEMETRY_MAX_CHART_POINTS_PER_ACCOUNT = 800;

export interface ProviderTelemetryChartPoint {
  observedAtMs: number;
  reading: TelemetryQuotaReading;
}

export interface ProviderTelemetryChartSeries {
  accountId: string;
  accountLabel: string;
  points: ProviderTelemetryChartPoint[];
}

export function prepareProviderTelemetryChart(
  readings: readonly TelemetryQuotaReading[],
  maximumPerAccount = PROVIDER_TELEMETRY_MAX_CHART_POINTS_PER_ACCOUNT,
): ProviderTelemetryChartSeries[] {
  if (maximumPerAccount <= 0) return [];

  const seriesByAccount = new Map<string, ProviderTelemetryChartSeries>();
  for (const reading of readings) {
    const observedAtMs = Date.parse(reading.observedAt);
    if (!Number.isFinite(observedAtMs)) continue;

    const existing = seriesByAccount.get(reading.providerAccountId);
    if (existing) {
      existing.points.push({ observedAtMs, reading });
    } else {
      seriesByAccount.set(reading.providerAccountId, {
        accountId: reading.providerAccountId,
        accountLabel: reading.providerAccountLabel,
        points: [{ observedAtMs, reading }],
      });
    }
  }

  return [...seriesByAccount.values()].map((series) => ({
    ...series,
    points: evenlySample(series.points, maximumPerAccount),
  }));
}

function evenlySample<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  if (maximum === 1) return [values.at(-1)!];

  const result: T[] = [];
  const lastIndex = values.length - 1;
  for (let index = 0; index < maximum; index += 1) {
    result.push(values[Math.round((index * lastIndex) / (maximum - 1))]!);
  }
  return result;
}
