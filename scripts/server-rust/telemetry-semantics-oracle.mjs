// Stream expectations from the actual production helpers. Only test plumbing
// converts the JSON date/number representation to its JavaScript runtime type.
import {
  quotaValueStatistics,
  deriveQuotaTokenAnalytics,
} from "../../cantrip_server/src/analytics/quota-token.ts";
import {
  sumDetailedTokenUsage,
  summarizeModelBehavior,
  groupModelBehavior,
} from "../../cantrip_server/src/analytics/telemetry-dashboard.ts";
import { sampleProviderTelemetryQuotaHistory } from "../../cantrip_server/src/models/provider-telemetry.ts";
import { detectTelemetryChanges } from "../../cantrip_server/src/analytics/telemetry-change-detection.ts";
import assert from "node:assert/strict";
let count = 0;
const changeCoverage = {
  metrics: new Set(),
  scopes: new Set(),
  confidence: new Set(),
  cap: false,
};
const special = (value) =>
  value && typeof value === "object" && "number" in value
    ? { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity }[value.number]
    : value;
const rows = (input) =>
  input.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key.endsWith("At") && value !== null
          ? new Date(special(value))
          : special(value),
      ]),
    ),
  );
function emit(op, input) {
  const result =
    op === "statistics"
      ? quotaValueStatistics(input.values.map(special))
      : op === "summary"
        ? {
            tokens: sumDetailedTokenUsage(rows(input.rows)),
            behavior: summarizeModelBehavior(rows(input.rows)),
            groups: [...groupModelBehavior(rows(input.rows), (row) => row.key)],
          }
        : op === "quota"
          ? deriveQuotaTokenAnalytics(
              rows(input.readings),
              rows(input.attempts),
              new Date(input.now),
            )
          : op === "changes"
            ? detectTelemetryChanges(
                input.quota.map((row) => ({
                  ...row,
                  effectiveTokensPer100Percent: special(
                    row.effectiveTokensPer100Percent,
                  ),
                  tokensPerPercent: {
                    comparableTokens: special(
                      row.tokensPerPercent.comparableTokens,
                    ),
                  },
                })),
                rows(input.behavior),
              )
            : sampleProviderTelemetryQuotaHistory(
                input.readings,
                special(input.maximum),
              );
  if (op === "changes") {
    for (const change of result) {
      changeCoverage.metrics.add(change.metric);
      changeCoverage.scopes.add(change.scope);
      changeCoverage.confidence.add(change.confidence);
    }
    if (result.length === 100) changeCoverage.cap = true;
  }
  process.stdout.write(
    JSON.stringify({ id: count++, op, input, expected: result }) + "\n",
  );
}
let seed = 0x1487fab;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const specials = [
  { number: "NaN" },
  { number: "Infinity" },
  { number: "-Infinity" },
];
for (const values of [
  [],
  [0],
  [-0],
  [1, 2],
  [2, 1],
  [Number.MAX_VALUE, Number.MAX_VALUE],
  [-Number.MAX_VALUE, Number.MAX_VALUE],
  [-0.5, 0.49999999999999994, 0.5],
  [...specials],
  [1, ...specials, 2],
])
  emit("statistics", { values });
for (let index = 0; index < 2000; index++) {
  const values = Array.from({ length: random() % 65 }, () =>
    random() % 9 === 0
      ? specials[random() % specials.length]
      : ((random() % 2001) - 1000) * 10 ** ((random() % 61) - 30),
  );
  emit("statistics", { values });
}
const counters = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolCallCount",
  "invalidToolCallCount",
  "retryFailoverCount",
  "compactionCount",
  "approvalRequestCount",
  "filesChangedCount",
  "testCommandCount",
  "testFailureCount",
];
const statuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "compacted",
  "unknown",
  "",
];
const keys = [
  "one",
  "two",
  "__proto__",
  "constructor",
  "ΟΣ",
  "ος",
  "\ud800",
  "🦀",
];
emit("summary", { rows: [] });
for (let index = 0; index < 1000; index++) {
  const input = Array.from({ length: random() % 33 }, () => {
    const start = 1793059200000 + (random() % 100000);
    return {
      ...Object.fromEntries(counters.map((key) => [key, (random() % 201) - 5])),
      key: keys[random() % keys.length],
      attemptStatus: statuses[random() % statuses.length],
      finalAnswerAppeared: !!(random() % 2),
      immediateCorrectiveFollowup: !!(random() % 2),
      durationMs: random() % 3 === 0 ? null : random() % 10000,
      startedAt: start,
      firstActivityAt:
        random() % 3 === 0 ? null : start + (random() % 10000) - 3000,
      firstVisibleResponseAt:
        random() % 3 === 0 ? null : start + (random() % 10000) - 3000,
    };
  });
  emit("summary", { rows: input });
}
const base = {
  ...Object.fromEntries(counters.map((key) => [key, 0])),
  key: "edge",
  attemptStatus: "completed",
  finalAnswerAppeared: false,
  immediateCorrectiveFollowup: false,
  durationMs: null,
  startedAt: 0,
  firstActivityAt: null,
  firstVisibleResponseAt: null,
};
for (const startedAt of [
  0,
  0.9,
  -0.9,
  -8.64e15,
  8.64e15,
  8.64e15 + 1,
  "invalid",
  "2026-10-27T00:00:00.000Z",
])
  for (const firstActivityAt of [0, 1, -1, null, "invalid", 8.64e15 + 1])
    emit("summary", {
      rows: [
        {
          ...base,
          startedAt,
          firstActivityAt,
          firstVisibleResponseAt: firstActivityAt,
          durationMs: { number: "NaN" },
        },
      ],
    });
emit("summary", {
  rows: [
    { ...base, inputTokens: 1e16, outputTokens: 1 },
    { ...base, inputTokens: -1e16, outputTokens: 1 },
  ],
});
for (const length of [0, 1, 2, 3, 799, 800, 801, 1601, 2403]) {
  const readings = Array.from({ length }, (_, index) => ({
    id: "r" + index,
    providerAccountId: keys[index % 3],
    marker: index % 7,
  }));
  for (const maximum of [-1, 0, 0.5, 1, 1.5, 2, 3, 800, 801, ...specials])
    emit("sample", { readings, maximum });
}
// Equal values are separate objects: reference Set identity must not become
// value/ID deduplication when chart samples are chosen.
emit("sample", {
  readings: Array.from({ length: 1000 }, () => ({
    id: "same",
    providerAccountId: "same",
  })),
  maximum: 3,
});
const epoch = Date.parse("2026-10-27T00:00:00.000Z");
const quotaReading = (id, time, used, extra = {}) => ({
  id,
  providerId: "provider",
  providerAccountId: "account",
  limitId: null,
  limitName: null,
  windowKind: "weekly",
  windowDurationMinutes: 10080,
  resetsAt: null,
  observedAt: time,
  receivedAt: time,
  usedPercent: used,
  ...extra,
});
const tokenAttempt = (id, time, extra = {}) => ({
  id,
  providerId: "provider",
  providerAccountId: "account",
  modelId: "model",
  modelName: "Model",
  reasoningEffort: null,
  projectId: null,
  startedAt: time,
  completedAt: null,
  finalizedAt: null,
  attemptStatus: "completed",
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 0,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  visibleOutputTokens: 15,
  reportedTotalTokens: 120,
  ...extra,
});
emit("quota", { readings: [], attempts: [], now: epoch });
for (const used of [
  [1, 1, 2, 1, 1, 3],
  [1, 2, 3],
  [1, 0, 1],
  [0, 0, 0],
]) {
  const readings = used.map((value, i) =>
    quotaReading("r" + i, epoch + i * 1000, value),
  );
  for (const attempts of [
    [],
    [tokenAttempt("a", epoch + 500)],
    [
      tokenAttempt("a", epoch + 500),
      tokenAttempt("b", epoch + 2500, {
        attemptStatus: "failed",
        visibleOutputTokens: null,
      }),
    ],
  ])
    emit("quota", { readings, attempts, now: epoch + 10000 });
}
const dimensions = [
  "A",
  "a",
  "ä",
  "z",
  "Z",
  "__proto__",
  "constructor",
  "x:y",
  "ΟΣ",
  "ος",
  "\ud800",
  "🦀",
  "",
  null,
];
for (let scenario = 0; scenario < 350; scenario++) {
  const readings = [],
    attempts = [];
  const start = epoch - (random() % 100) * 86400000;
  const n = 2 + (random() % 25);
  let used = 0;
  for (let i = 0; i < n; i++) {
    used += random() % 4 === 0 ? -5 : random() % 4;
    const time = start + i * 86400000 + (random() % 1000);
    const extra = {
      providerId: dimensions[random() % 12],
      providerAccountId: "account" + (random() % 3),
      limitId: dimensions[random() % dimensions.length],
      limitName: dimensions[random() % dimensions.length],
      windowKind: ["weekly", "secondary", "week", "7d", "other"][random() % 5],
      windowDurationMinutes: [null, 10080, 60][random() % 3],
      resetsAt: random() % 3 === 0 ? null : epoch + 86400000 * (random() % 2),
      receivedAt: time + (random() % 10000) - 1000,
    };
    // Retain long same-bucket histories as well as interleaved independent ones.
    readings.push(quotaReading("r" + i, time, used, scenario % 2 ? extra : {}));
    for (let j = 0; j < random() % 4; j++)
      attempts.push(
        tokenAttempt("a" + i + "-" + j, time - 500 + (random() % 1000), {
          providerAccountId: scenario % 2 ? extra.providerAccountId : "account",
          modelId: dimensions[random() % dimensions.length],
          modelName: dimensions[random() % 12],
          reasoningEffort: dimensions[random() % dimensions.length],
          projectId: dimensions[random() % dimensions.length],
          attemptStatus: statuses[random() % statuses.length],
          inputTokens: random() % 100000,
          outputTokens: random() % 10000,
          visibleOutputTokens: random() % 2 ? null : random() % 1000,
          reportedTotalTokens: random() % 2 ? null : random() % 10000,
          completedAt: random() % 2 ? null : time,
          finalizedAt: random() % 2 ? null : time + 50,
        }),
      );
  }
  if (random() % 2) readings.reverse();
  emit("quota", { readings, attempts, now: epoch });
}
// Calendar buckets preserve Date.UTC's two-digit-year adjustment, expanded
// ISO years and the full Date TimeClip boundary, including invalid week targets.
for (const now of [
  -8640000000000000,
  8640000000000000,
  -62167219200000,
  -59011459200000,
  -59011459200000 + 32 * 86400000,
  253402300800000,
  epoch,
  0,
]) {
  const before = now === -8640000000000000 ? now : now - 1000;
  const through = now === -8640000000000000 ? now + 1000 : now;
  emit("quota", {
    readings: [
      quotaReading("before", before, 1),
      quotaReading("after", through, 2),
    ],
    attempts: [tokenAttempt("edge", through)],
    now,
  });
}
// Independent f64 accumulation orders, nonfinite metrics and colon-delimited
// key collisions must not become integer sums or structured tuple keys.
emit("quota", {
  readings: [quotaReading("b", epoch, 0), quotaReading("a", epoch + 1000, 1)],
  attempts: [
    tokenAttempt("1", epoch + 100, { inputTokens: 1e16, outputTokens: 1 }),
    tokenAttempt("2", epoch + 200, { inputTokens: -1e16, outputTokens: 1 }),
  ],
  now: epoch + 2000,
});
const quotaSample = (index, time, value, extra = {}) => ({
  accountId: "account",
  providerId: "provider",
  bucketKey: "provider:account:weekly:10080",
  resetWindowKey: "reset",
  fromObservedAt: new Date(time - 1000).toISOString(),
  toObservedAt: new Date(time).toISOString(),
  usedPercentDelta: 1,
  stationaryReadingCount: 0,
  attemptCount: 1,
  tokens: {},
  tokensPerPercent: { comparableTokens: value },
  effectiveTokensPer100Percent: value * 100,
  modelIds: ["model"],
  modelNames: ["Model"],
  reasoningEfforts: [],
  projectIds: [],
  observationLagMs: 0,
  confidence: "high",
  confidenceReasons: [],
  unattributed: false,
  ...extra,
});
const behaviorRow = (index, time, after, extra = {}) => ({
  ...base,
  providerAccountId: "account",
  modelId: "model",
  startedAt: time,
  attemptStatus: after ? "failed" : "completed",
  toolCallCount: 10,
  invalidToolCallCount: after ? 8 : 0,
  durationMs: after ? 10000 : 1000,
  compactionCount: after ? 2 : 0,
  outputTokens: 100,
  reasoningOutputTokens: after ? 90 : 10,
  ...extra,
});
emit("changes", { quota: [], behavior: [] });
for (const bucketKey of [
  "weekly",
  "week",
  "7d",
  "10080",
  "WEeKLY",
  "x:week:y",
  "x:7d:y",
  "weekly-extra",
  "xweekly",
  "x:100800:y",
]) {
  emit("changes", {
    quota: Array.from({ length: 40 }, (_, i) =>
      quotaSample(i, epoch + i * 1000, i < 20 ? 100 : 1000, { bucketKey }),
    ),
    behavior: [],
  });
}
for (const length of [9, 10, 15, 16, 19, 20, 31, 32, 40, 80, 101]) {
  for (const reverse of [false, true]) {
    const quota = Array.from({ length }, (_, i) =>
      quotaSample(i, epoch + i * 1000, i < length / 2 ? 100 : 1000),
    );
    const behavior = Array.from({ length }, (_, i) =>
      behaviorRow(i, epoch + i * 1000, i >= length / 2),
    );
    if (reverse) {
      quota.reverse();
      behavior.reverse();
    }
    emit("changes", { quota, behavior });
  }
}
for (let scenario = 0; scenario < 180; scenario++) {
  const length = 16 + (random() % 100);
  const quota = [],
    behavior = [];
  for (let i = 0; i < length; i++) {
    const after = i >= length / 2;
    const identity = {
      accountId: dimensions[random() % dimensions.length],
      modelIds: random() % 4 === 0 ? [] : [dimensions[random() % 12]],
    };
    quota.push(
      quotaSample(
        i,
        epoch + i * 1000,
        after ? 1000 + (random() % 100) : 100 + (random() % 10),
        scenario % 2
          ? {
              ...identity,
              confidence: random() % 2 ? "high" : "medium",
              unattributed: random() % 5 === 0,
              bucketKey: [
                "other",
                "weekly",
                "WEeKLY",
                "x:7d:y",
                "x:10080:y",
                "weekly-extra",
              ][random() % 6],
            }
          : {},
      ),
    );
    behavior.push(
      behaviorRow(
        i,
        epoch + i * 1000,
        after,
        scenario % 2
          ? {
              providerAccountId: identity.accountId,
              modelId: identity.modelIds[0] ?? null,
              attemptStatus: statuses[random() % statuses.length],
              durationMs: random() % 4 === 0 ? null : random() % 10000,
              invalidToolCallCount: random() % 8,
              compactionCount: random() % 4,
              reasoningOutputTokens: random() % 100,
            }
          : {},
      ),
    );
  }
  emit("changes", { quota, behavior });
}
for (const pair of [
  [0, 1],
  [Number.EPSILON / 2, 1],
  [Number.EPSILON, 1],
  [-1, -2],
  [-1, 1],
  [Number.MAX_VALUE / 4, Number.MAX_VALUE / 2],
  [Number.MAX_VALUE / 2, Number.MAX_VALUE],
  [1, 1.25],
  [1, 1.2499999999999998],
]) {
  emit("changes", {
    quota: Array.from({ length: 40 }, (_, i) =>
      quotaSample(i, epoch + i * 1000, pair[i < 20 ? 0 : 1]),
    ),
    behavior: Array.from({ length: 40 }, (_, i) =>
      behaviorRow(i, epoch + i * 1000, i >= 20, {
        durationMs: pair[i < 20 ? 0 : 1],
      }),
    ),
  });
}
for (const invalid of [null, ...specials])
  emit("changes", {
    quota: Array.from({ length: 40 }, (_, i) =>
      quotaSample(i, epoch + i * 1000, i < 20 ? 100 : 1000, {
        tokensPerPercent: { comparableTokens: invalid },
        effectiveTokensPer100Percent: invalid,
      }),
    ),
    behavior: Array.from({ length: 40 }, (_, i) =>
      behaviorRow(i, epoch + i * 1000, i >= 20, { durationMs: invalid }),
    ),
  });
emit("changes", {
  quota: [],
  behavior: Array.from({ length: 30 }, (_, group) =>
    Array.from({ length: 40 }, (_, i) =>
      behaviorRow(i, epoch + i * 1000, i >= 20, {
        providerAccountId: "account" + group,
        modelId: "model" + group,
      }),
    ),
  ).flat(),
});
assert.equal(
  changeCoverage.metrics.size,
  8,
  "all actual Source change metrics exercised",
);
assert.equal(
  changeCoverage.scopes.size,
  3,
  "all Source change scopes exercised",
);
assert.equal(
  changeCoverage.confidence.size,
  2,
  "both Source confidence outcomes exercised",
);
assert.equal(changeCoverage.cap, true, "actual Source100-result cap exercised");
process.stdout.write(JSON.stringify({ done: count }) + "\n");
