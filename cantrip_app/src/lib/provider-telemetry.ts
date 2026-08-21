import {
  providerTelemetryAnalyticsSchema,
  providerTelemetryWireAnalyticsSchema,
  type ModelProfileSummary,
  type ModelProviderSummary,
  type ProviderTelemetryAnalytics,
} from "@cantrip/protocol";

function visibleDimension(id: string, labels: ReadonlyMap<string, string>) {
  return labels.get(id) ?? id;
}

export function openProviderTelemetryWireAnalytics(
  raw: unknown,
  provider: ModelProviderSummary,
  models: readonly ModelProfileSummary[],
): ProviderTelemetryAnalytics {
  const wire = providerTelemetryWireAnalyticsSchema.parse(raw);
  const accountLabels = new Map(
    provider.accounts.map((account) => [account.id, account.label] as const),
  );
  const modelLabels = new Map(
    models.map((model) => [model.id, model.name] as const),
  );
  const quotaReading = (reading: (typeof wire.currentQuota)[number]) => ({
    ...reading,
    limitId: undefined,
    providerName: provider.name,
    providerAccountLabel: visibleDimension(
      reading.providerAccountId,
      accountLabels,
    ),
    limitName: reading.limitId ?? reading.windowKind,
  });
  const breakdown = (
    row: (typeof wire.breakdowns.accounts)[number],
    labels?: ReadonlyMap<string, string>,
  ) => ({
    ...row,
    label: labels ? visibleDimension(row.key, labels) : row.key,
  });
  const behavior = (
    row: (typeof wire.behavior.accounts)[number],
    labels?: ReadonlyMap<string, string>,
  ) => ({
    ...row,
    label: labels ? visibleDimension(row.key, labels) : row.key,
  });

  return providerTelemetryAnalyticsSchema.parse({
    ...wire,
    accounts: wire.accounts.map((account) => ({
      ...account,
      providerName: provider.name,
      label: visibleDimension(account.id, accountLabels),
    })),
    currentQuota: wire.currentQuota.map(quotaReading),
    quotaHistory: wire.quotaHistory.map(quotaReading),
    breakdowns: {
      accounts: wire.breakdowns.accounts.map((row) =>
        breakdown(row, accountLabels),
      ),
      models: wire.breakdowns.models.map((row) => breakdown(row, modelLabels)),
      reasoningEfforts: wire.breakdowns.reasoningEfforts.map((row) =>
        breakdown(row),
      ),
      months: wire.breakdowns.months.map((row) => breakdown(row)),
    },
    behavior: {
      ...wire.behavior,
      accounts: wire.behavior.accounts.map((row) =>
        behavior(row, accountLabels),
      ),
      models: wire.behavior.models.map((row) => behavior(row, modelLabels)),
      reasoningEfforts: wire.behavior.reasoningEfforts.map((row) =>
        behavior(row),
      ),
    },
    changePoints: wire.changePoints.map((change) => ({
      ...change,
      providerAccountLabel: change.providerAccountId
        ? visibleDimension(change.providerAccountId, accountLabels)
        : null,
      modelLabel: change.modelId
        ? visibleDimension(change.modelId, modelLabels)
        : null,
    })),
  });
}
