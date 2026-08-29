import { z } from "zod";
import {
  detailedTokenUsageTotalsSchema,
  agentTimeSummarySchema,
} from "./providers.js";

export const projectGitRepositoryStatsSchema = z.object({
  kind: z.literal("git").default("git"),
  commitCount: z.number().int().nonnegative(),
  trackedFileCount: z.number().int().nonnegative(),
  trackedByteCount: z.number().int().nonnegative(),
  textFileCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  excludedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const projectFolderStatsSchema = z.object({
  kind: z.literal("folder"),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  textFileCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  excludedFileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const projectRepositoryStatsSchema = z.union([
  projectGitRepositoryStatsSchema,
  projectFolderStatsSchema,
]);

export const projectTokenUsageDaySchema = detailedTokenUsageTotalsSchema.extend(
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  },
);

export const projectTokenUsageBreakdownSchema =
  detailedTokenUsageTotalsSchema.extend({
    id: z.string().min(1).nullable(),
    name: z.string().min(1),
    agentTime: agentTimeSummarySchema,
  });

export const projectTokenUsageSchema = z.object({
  total: detailedTokenUsageTotalsSchema,
  agentTime: agentTimeSummarySchema,
  daily: z.array(projectTokenUsageDaySchema).max(366),
  providers: z.array(projectTokenUsageBreakdownSchema),
  models: z.array(projectTokenUsageBreakdownSchema),
  range: z.object({
    start: projectTokenUsageDaySchema.shape.date,
    end: projectTokenUsageDaySchema.shape.date,
  }),
});

export const telemetryValueStatisticsSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  mean: z.number().finite().nullable(),
  median: z.number().finite().nullable(),
  min: z.number().finite().nullable(),
  p10: z.number().finite().nullable(),
  p25: z.number().finite().nullable(),
  p75: z.number().finite().nullable(),
  p90: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
});

export const telemetryQuotaReadingSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  providerAccountId: z.string().min(1),
  providerAccountLabel: z.string().min(1),
  limitName: z.string().min(1),
  windowKind: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  remainingPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
});

export const telemetryQuotaReadingWireSchema = telemetryQuotaReadingSchema
  .omit({
    providerName: true,
    providerAccountLabel: true,
    limitName: true,
  })
  .extend({ limitId: z.string().nullable() })
  .strict();

export const telemetryBreakdownSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  sampleCount: z.number().int().nonnegative(),
  highConfidenceSamples: z.number().int().nonnegative(),
  unattributedSamples: z.number().int().nonnegative(),
  tokens: detailedTokenUsageTotalsSchema,
  effectiveTokensPer100Percent: telemetryValueStatisticsSchema,
});

export const telemetryBreakdownWireSchema = telemetryBreakdownSchema
  .omit({ label: true })
  .strict();

export const modelBehaviorSummarySchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  interruptedCount: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1).nullable(),
  finalAnswerRate: z.number().min(0).max(1).nullable(),
  toolCallCount: z.number().int().nonnegative(),
  invalidToolCallCount: z.number().int().nonnegative(),
  toolErrorRate: z.number().min(0).max(1).nullable(),
  retryFailoverCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  approvalRequestCount: z.number().int().nonnegative(),
  filesChangedCount: z.number().int().nonnegative(),
  testCommandCount: z.number().int().nonnegative(),
  testFailureCount: z.number().int().nonnegative(),
  immediateCorrectiveFollowupCount: z.number().int().nonnegative(),
  durationMs: telemetryValueStatisticsSchema,
  timeToFirstActivityMs: telemetryValueStatisticsSchema,
  timeToVisibleResponseMs: telemetryValueStatisticsSchema,
});

export const modelBehaviorBreakdownSchema = modelBehaviorSummarySchema.extend({
  key: z.string().min(1),
  label: z.string().min(1),
});

export const modelBehaviorDaySchema = modelBehaviorSummarySchema.extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

export const telemetryChangeMetricSchema = z.enum([
  "tokens-per-percent",
  "effective-weekly-allowance",
  "failure-rate",
  "tool-error-rate",
  "latency",
  "compaction-frequency",
  "completion-rate",
  "output-reasoning-mix",
]);

export const telemetryChangePointSchema = z.object({
  id: z.string().min(1),
  metric: telemetryChangeMetricSchema,
  scope: z.enum(["account", "model", "account-model"]),
  providerAccountId: z.string().min(1).nullable(),
  providerAccountLabel: z.string().min(1).nullable(),
  modelId: z.string().min(1).nullable(),
  modelLabel: z.string().min(1).nullable(),
  detectedAt: z.string().datetime(),
  beforeStart: z.string().datetime(),
  beforeEnd: z.string().datetime(),
  afterStart: z.string().datetime(),
  afterEnd: z.string().datetime(),
  beforeValue: z.number().finite(),
  afterValue: z.number().finite(),
  relativeChangePercent: z.number().finite().nullable(),
  beforeSampleCount: z.number().int().positive(),
  afterSampleCount: z.number().int().positive(),
  confidence: z.enum(["high", "medium"]),
  direction: z.enum(["increased", "decreased"]),
  impact: z.enum(["improvement", "degradation", "neutral"]),
  unit: z.enum(["tokens", "ratio", "milliseconds"]),
});

export const telemetryChangePointWireSchema = telemetryChangePointSchema
  .omit({ providerAccountLabel: true, modelLabel: true })
  .strict();

export const providerTelemetryAnalyticsSchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      providerId: z.string().min(1),
      providerName: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
  currentQuota: z.array(telemetryQuotaReadingSchema),
  quotaHistory: z.array(telemetryQuotaReadingSchema),
  resetBoundaries: z.array(
    z.object({
      providerAccountId: z.string().min(1),
      resetsAt: z.string().datetime(),
      firstObservedAt: z.string().datetime(),
    }),
  ),
  tokens: z.object({
    total: detailedTokenUsageTotalsSchema,
    daily: z.array(projectTokenUsageDaySchema).max(366),
  }),
  estimates: z.object({
    sampleCount: z.number().int().nonnegative(),
    highConfidenceSamples: z.number().int().nonnegative(),
    unattributedSamples: z.number().int().nonnegative(),
    tokensPerPercent: telemetryValueStatisticsSchema,
    effectiveTokensPer100Percent: telemetryValueStatisticsSchema,
  }),
  comparisons: z.object({
    rolling7Days: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
    rolling30Days: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
    monthOverMonth: z.object({
      current: telemetryValueStatisticsSchema,
      previous: telemetryValueStatisticsSchema,
      changePercent: z.number().finite().nullable(),
    }),
  }),
  breakdowns: z.object({
    accounts: z.array(telemetryBreakdownSchema),
    models: z.array(telemetryBreakdownSchema),
    reasoningEfforts: z.array(telemetryBreakdownSchema),
    months: z.array(telemetryBreakdownSchema),
  }),
  behavior: z.object({
    total: modelBehaviorSummarySchema,
    daily: z.array(modelBehaviorDaySchema).max(366),
    accounts: z.array(modelBehaviorBreakdownSchema),
    models: z.array(modelBehaviorBreakdownSchema),
    reasoningEfforts: z.array(modelBehaviorBreakdownSchema),
  }),
  changePoints: z.array(telemetryChangePointSchema).max(100),
});

export const providerTelemetryWireAnalyticsSchema =
  providerTelemetryAnalyticsSchema
    .omit({
      accounts: true,
      currentQuota: true,
      quotaHistory: true,
      breakdowns: true,
      behavior: true,
      changePoints: true,
    })
    .extend({
      accounts: z.array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
          })
          .strict(),
      ),
      currentQuota: z.array(telemetryQuotaReadingWireSchema),
      quotaHistory: z.array(telemetryQuotaReadingWireSchema),
      breakdowns: z.object({
        accounts: z.array(telemetryBreakdownWireSchema),
        models: z.array(telemetryBreakdownWireSchema),
        reasoningEfforts: z.array(telemetryBreakdownWireSchema),
        months: z.array(telemetryBreakdownWireSchema),
      }),
      behavior: z.object({
        total: modelBehaviorSummarySchema,
        daily: z.array(modelBehaviorDaySchema).max(366),
        accounts: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
        models: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
        reasoningEfforts: z.array(
          modelBehaviorBreakdownSchema.omit({ label: true }).strict(),
        ),
      }),
      changePoints: z.array(telemetryChangePointWireSchema).max(100),
    })
    .strict();

const telemetryExportQuotaObservationSchema = z.object({
  id: z.string().min(1),
  eventKey: z.string().min(1),
  observationBatchKey: z.string().min(1),
  providerAccountId: z.string().min(1),
  workerId: z.string().nullable(),
  observedAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  usedPercent: z.number().finite(),
  resetsAt: z.string().datetime().nullable(),
  windowDurationMinutes: z.number().int().nonnegative().nullable(),
  limitId: z.string().nullable(),
  windowKind: z.string().min(1),
  reachedType: z.string().nullable(),
  observationTrigger: z.string().min(1),
  chatId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
});

const telemetryExportTokenUsageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().nullable(),
  chatId: z.string().nullable(),
  sourceKey: z.string().min(1),
  modelId: z.string().nullable(),
  modelRouteId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().nullable(),
  attemptKind: z.string().min(1),
  attemptStatus: z.string().min(1),
  reasoningEffort: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  visibleOutputTokens: z.number().int().nonnegative().nullable(),
  reportedTotalTokens: z.number().int().nonnegative().nullable(),
  usageSemantics: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
});

const telemetryExportBehaviorSchema = z.object({
  id: z.string().min(1),
  sourceKey: z.string().min(1),
  projectId: z.string().nullable(),
  chatId: z.string().nullable(),
  modelId: z.string().nullable(),
  modelRouteId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  turnId: z.string().nullable(),
  executionAttemptId: z.string().min(1),
  attemptStatus: z.string().min(1),
  reasoningEffort: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  finalAnswerAppeared: z.boolean(),
  toolCallCount: z.number().int().nonnegative(),
  invalidToolCallCount: z.number().int().nonnegative(),
  retryFailoverCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  approvalRequestCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  filesChangedCount: z.number().int().nonnegative(),
  testCommandCount: z.number().int().nonnegative(),
  testPassCount: z.number().int().nonnegative(),
  testFailureCount: z.number().int().nonnegative(),
  userInterrupted: z.boolean(),
  userRetryRegeneration: z.boolean().nullable(),
  immediateCorrectiveFollowup: z.boolean(),
  forkCount: z.number().int().nonnegative(),
  copyCount: z.number().int().nonnegative().nullable(),
  ratingValue: z.number().int().nullable(),
  workerVersion: z.string().nullable(),
  serverVersion: z.string().nullable(),
  codexVersion: z.string().nullable(),
  signalAvailability: z.record(z.string(), z.unknown()),
});

const telemetryExportCatalogSnapshotSchema = z.object({
  id: z.string().min(1),
  providerAccountId: z.string().nullable(),
  workerId: z.string().nullable(),
  availabilityScope: z.string().min(1),
  metadataSource: z.string().min(1),
  metadataHash: z.string().min(1),
  observedAt: z.string().datetime(),
});

export const providerTelemetryExportSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  provider: z.object({ id: z.string().min(1) }),
  privacy: z.object({
    includesMessageContent: z.literal(false),
    rawPayloadsStored: z.literal(false),
    dimensionLabels: z.literal("opaque-ids"),
    retention: z.literal("owner-controlled-indefinite"),
  }),
  quotaObservations: z.array(telemetryExportQuotaObservationSchema),
  tokenUsage: z.array(telemetryExportTokenUsageSchema),
  modelBehavior: z.array(telemetryExportBehaviorSchema),
  modelCatalogSnapshots: z.array(telemetryExportCatalogSnapshotSchema),
});

export const providerTelemetryDeleteResultSchema = z.object({
  providerId: z.string().min(1),
  deleted: z.object({
    quotaObservations: z.number().int().nonnegative(),
    tokenUsage: z.number().int().nonnegative(),
    modelBehavior: z.number().int().nonnegative(),
    modelCatalogSnapshots: z.number().int().nonnegative(),
  }),
});

export type ProjectRepositoryStats = z.infer<
  typeof projectRepositoryStatsSchema
>;
export type ProjectGitRepositoryStats = z.infer<
  typeof projectGitRepositoryStatsSchema
>;
export type ProjectFolderStats = z.infer<typeof projectFolderStatsSchema>;
export type ProjectTokenUsageDay = z.infer<typeof projectTokenUsageDaySchema>;
export type ProjectTokenUsageBreakdown = z.infer<
  typeof projectTokenUsageBreakdownSchema
>;
export type ProjectTokenUsage = z.infer<typeof projectTokenUsageSchema>;
export type TelemetryValueStatistics = z.infer<
  typeof telemetryValueStatisticsSchema
>;
export type TelemetryQuotaReading = z.infer<typeof telemetryQuotaReadingSchema>;
export type TelemetryBreakdown = z.infer<typeof telemetryBreakdownSchema>;
export type ModelBehaviorSummary = z.infer<typeof modelBehaviorSummarySchema>;
export type TelemetryChangeMetric = z.infer<typeof telemetryChangeMetricSchema>;
export type TelemetryChangePoint = z.infer<typeof telemetryChangePointSchema>;
export type ProviderTelemetryAnalytics = z.infer<
  typeof providerTelemetryAnalyticsSchema
>;
export type ProviderTelemetryWireAnalytics = z.infer<
  typeof providerTelemetryWireAnalyticsSchema
>;
export type ProviderTelemetryExport = z.infer<
  typeof providerTelemetryExportSchema
>;
export type ProviderTelemetryDeleteResult = z.infer<
  typeof providerTelemetryDeleteResultSchema
>;
