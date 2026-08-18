export const PROVIDER_TELEMETRY_MAX_CHART_POINTS_PER_ACCOUNT = 800;

export function sampleProviderTelemetryQuotaHistory<
  Reading extends { providerAccountId: string },
>(
  readings: readonly Reading[],
  maximumPerAccount = PROVIDER_TELEMETRY_MAX_CHART_POINTS_PER_ACCOUNT,
): Reading[] {
  if (maximumPerAccount <= 0 || readings.length === 0) return [];

  const readingsByAccount = new Map<string, Reading[]>();
  for (const reading of readings) {
    const accountReadings = readingsByAccount.get(reading.providerAccountId);
    if (accountReadings) accountReadings.push(reading);
    else readingsByAccount.set(reading.providerAccountId, [reading]);
  }

  const selected = new Set<Reading>();
  for (const accountReadings of readingsByAccount.values()) {
    if (accountReadings.length <= maximumPerAccount) {
      for (const reading of accountReadings) selected.add(reading);
      continue;
    }

    if (maximumPerAccount === 1) {
      selected.add(accountReadings.at(-1)!);
      continue;
    }

    const lastIndex = accountReadings.length - 1;
    for (let index = 0; index < maximumPerAccount; index += 1) {
      selected.add(
        accountReadings[
          Math.round((index * lastIndex) / (maximumPerAccount - 1))
        ]!,
      );
    }
  }

  return readings.filter((reading) => selected.has(reading));
}
