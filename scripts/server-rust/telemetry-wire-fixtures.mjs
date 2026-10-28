// Explicit protocol examples and boundary mutations for the native exporter.
const at = "2026-10-27T00:00:00.000Z";
const nullable = (keys) => Object.fromEntries(keys.map((key) => [key, null]));
const counters = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const tokens = {
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 3,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  totalTokens: 120,
};
const stats = {
  sampleCount: 0,
  mean: null,
  median: null,
  min: null,
  p10: null,
  p25: null,
  p75: null,
  p90: null,
  max: null,
};
const comparison = { current: stats, previous: stats, changePercent: null };
const behavior = {
  ...counters([
    "attemptCount",
    "completedCount",
    "failedCount",
    "interruptedCount",
    "toolCallCount",
    "invalidToolCallCount",
    "retryFailoverCount",
    "compactionCount",
    "approvalRequestCount",
    "filesChangedCount",
    "testCommandCount",
    "testFailureCount",
    "immediateCorrectiveFollowupCount",
  ]),
  completionRate: null,
  finalAnswerRate: null,
  toolErrorRate: null,
  durationMs: stats,
  timeToFirstActivityMs: stats,
  timeToVisibleResponseMs: stats,
};
const reading = {
  id: "reading",
  providerId: "provider",
  providerAccountId: "account",
  limitId: null,
  windowKind: "weekly",
  usedPercent: 25,
  remainingPercent: 75,
  resetsAt: null,
  observedAt: at,
};
const breakdown = {
  key: "account",
  sampleCount: 1,
  highConfidenceSamples: 1,
  unattributedSamples: 0,
  tokens,
  effectiveTokensPer100Percent: stats,
};
const change = {
  id: "change",
  metric: "latency",
  scope: "account-model",
  providerAccountId: "account",
  modelId: "model",
  detectedAt: at,
  beforeStart: at,
  beforeEnd: at,
  afterStart: at,
  afterEnd: at,
  beforeValue: 1000,
  afterValue: 10000,
  relativeChangePercent: 900,
  beforeSampleCount: 16,
  afterSampleCount: 16,
  confidence: "high",
  direction: "increased",
  impact: "degradation",
  unit: "milliseconds",
};
const analytics = {
  generatedAt: at,
  range: { from: at, to: at },
  accounts: [],
  currentQuota: [],
  quotaHistory: [],
  resetBoundaries: [],
  tokens: { total: tokens, daily: [] },
  estimates: {
    sampleCount: 0,
    highConfidenceSamples: 0,
    unattributedSamples: 0,
    tokensPerPercent: stats,
    effectiveTokensPer100Percent: stats,
  },
  comparisons: {
    rolling7Days: comparison,
    rolling30Days: comparison,
    monthOverMonth: comparison,
  },
  breakdowns: { accounts: [], models: [], reasoningEfforts: [], months: [] },
  behavior: {
    total: behavior,
    daily: [],
    accounts: [],
    models: [],
    reasoningEfforts: [],
  },
  changePoints: [],
};
const analyticsPopulated = {
  ...analytics,
  accounts: [{ id: "account", providerId: "provider" }],
  currentQuota: [reading],
  quotaHistory: [reading],
  resetBoundaries: [
    { providerAccountId: "account", resetsAt: at, firstObservedAt: at },
  ],
  tokens: { total: tokens, daily: [{ date: "2026-10-27", ...tokens }] },
  breakdowns: {
    accounts: [breakdown],
    models: [breakdown],
    reasoningEfforts: [breakdown],
    months: [breakdown],
  },
  behavior: {
    total: behavior,
    daily: [{ date: "2026-10-27", ...behavior }],
    accounts: [{ key: "account", ...behavior }],
    models: [{ key: "model", ...behavior }],
    reasoningEfforts: [{ key: "high", ...behavior }],
  },
  changePoints: [change],
};
const exportEmpty = {
  schemaVersion: 2,
  generatedAt: at,
  provider: { id: "provider" },
  privacy: {
    includesMessageContent: false,
    rawPayloadsStored: false,
    dimensionLabels: "opaque-ids",
    retention: "owner-controlled-indefinite",
  },
  quotaObservations: [],
  tokenUsage: [],
  modelBehavior: [],
  modelCatalogSnapshots: [],
};
const quotaExport = {
  id: "quota",
  eventKey: "event",
  observationBatchKey: "batch",
  providerAccountId: "account",
  ...nullable([
    "workerId",
    "resetsAt",
    "windowDurationMinutes",
    "limitId",
    "reachedType",
    "chatId",
    "turnId",
    "executionAttemptId",
    "workerVersion",
    "serverVersion",
    "codexVersion",
  ]),
  observedAt: at,
  receivedAt: at,
  usedPercent: 12.5,
  windowKind: "weekly",
  observationTrigger: "fixture",
};
const tokenExport = {
  id: "token",
  sourceKey: "source",
  ...nullable([
    "projectId",
    "chatId",
    "modelId",
    "modelRouteId",
    "providerAccountId",
    "workerId",
    "turnId",
    "executionAttemptId",
    "reasoningEffort",
    "visibleOutputTokens",
    "reportedTotalTokens",
    "startedAt",
    "completedAt",
    "finalizedAt",
    "workerVersion",
    "serverVersion",
    "codexVersion",
  ]),
  attemptKind: "native",
  attemptStatus: "completed",
  usageSemantics: "native",
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 3,
  outputTokens: 20,
  reasoningOutputTokens: 5,
};
const behaviorExport = {
  id: "behavior",
  sourceKey: "source",
  executionAttemptId: "attempt",
  ...nullable([
    "projectId",
    "chatId",
    "modelId",
    "modelRouteId",
    "providerAccountId",
    "workerId",
    "turnId",
    "reasoningEffort",
    "completedAt",
    "finalizedAt",
    "durationMs",
    "userRetryRegeneration",
    "copyCount",
    "ratingValue",
    "workerVersion",
    "serverVersion",
    "codexVersion",
  ]),
  attemptStatus: "completed",
  startedAt: at,
  finalAnswerAppeared: true,
  ...counters([
    "toolCallCount",
    "invalidToolCallCount",
    "retryFailoverCount",
    "compactionCount",
    "approvalRequestCount",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "filesChangedCount",
    "testCommandCount",
    "testPassCount",
    "testFailureCount",
    "forkCount",
  ]),
  userInterrupted: false,
  immediateCorrectiveFollowup: false,
  signalAvailability: { nativeReasoningKnown: false },
  nativeAttribution: {
    version: 1,
    turnIds: [],
    captures: [],
    conflictingTurnKeys: [],
  },
};
const exportPopulated = {
  ...exportEmpty,
  quotaObservations: [quotaExport],
  tokenUsage: [
    {
      ...tokenExport,
      nativeUsage: {
        version: 1,
        responses: [],
        complete: false,
        conflictingResponseIds: [],
      },
    },
  ],
  modelBehavior: [behaviorExport],
  modelCatalogSnapshots: [
    {
      id: "snapshot",
      providerAccountId: null,
      workerId: null,
      availabilityScope: "worker",
      metadataSource: "catalog",
      metadataHash: "hash",
      observedAt: at,
    },
  ],
};
export const telemetryWireFixtures = {
  providerTelemetryWireAnalyticsSchema: [analytics, analyticsPopulated],
  providerTelemetryExportSchema: [exportEmpty, exportPopulated],
  providerTelemetryDeleteResultSchema: [
    {
      providerId: "provider",
      deleted: {
        quotaObservations: 1,
        tokenUsage: 2,
        modelBehavior: 3,
        modelCatalogSnapshots: 4,
      },
    },
  ],
};
export function* telemetryWireCases(name) {
  if (name === "providerTelemetryWireAnalyticsSchema") {
    for (const count of [100, 101])
      yield { ...analytics, changePoints: Array(count).fill(change) };
    for (const count of [366, 367])
      yield {
        ...analytics,
        tokens: {
          total: tokens,
          daily: Array(count).fill({ date: "2026-10-27", ...tokens }),
        },
      };
    for (const count of [366, 367])
      yield {
        ...analytics,
        behavior: {
          ...analytics.behavior,
          daily: Array(count).fill({ date: "2026-10-27", ...behavior }),
        },
      };
    for (const value of [-1, 0, 100, 100.00000000000001])
      yield {
        ...analytics,
        currentQuota: [{ ...reading, usedPercent: value }],
      };
    yield {
      ...analytics,
      accounts: [
        {
          id: "account",
          providerId: "provider",
          label: "must reject plaintext label",
        },
      ],
    };
    yield {
      ...analytics,
      currentQuota: [
        { ...reading, providerName: "must reject plaintext provider" },
      ],
    };
  }
  if (name === "providerTelemetryExportSchema") {
    for (const depth of [100, 150, 300]) {
      let value = true;
      for (let i = 0; i < depth; i++) value = [value];
      yield {
        ...exportPopulated,
        modelBehavior: [
          {
            ...behaviorExport,
            signalAvailability: {
              nativeReasoningKnown: true,
              structured: value,
            },
          },
        ],
      };
    }
    yield {
      ...exportPopulated,
      modelBehavior: [
        {
          ...behaviorExport,
          signalAvailability: JSON.parse(
            '{"__proto__":{"safe":true},"constructor":false,"nativeReasoningKnown":true}',
          ),
        },
      ],
    };
    yield {
      ...exportPopulated,
      modelBehavior: [
        {
          ...behaviorExport,
          nativeAttribution: {
            ...behaviorExport.nativeAttribution,
            rawPayload: "must reject",
          },
        },
      ],
    };
    yield {
      ...exportPopulated,
      tokenUsage: [
        {
          ...tokenExport,
          nativeUsage: {
            version: 1,
            responses: [],
            complete: false,
            conflictingResponseIds: [],
            rawPayload: "must reject",
          },
        },
      ],
    };
  }
}
