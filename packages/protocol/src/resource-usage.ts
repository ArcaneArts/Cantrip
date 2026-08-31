import { z } from "zod";

export const resourceUsageDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u, "Expected a nonnegative decimal integer.");

export const accountStorageClassSchema = z.enum(["server", "worker-managed"]);

export const accountStorageCategorySchema = z.enum([
  "account",
  "analytics",
  "configuration",
  "conversations",
  "projects",
  "workflows",
]);

export const accountResourceUsageAccuracySchema = z.enum([
  "logical-reconciled",
  "server-known-estimate",
  "metered",
  "stale",
  "unavailable",
]);

export const accountResourceUsageStatusSchema = z.enum([
  "current",
  "stale",
  "unavailable",
]);

export const accountBandwidthDirectionSchema = z.enum(["ingress", "egress"]);

export const accountBandwidthChannelSchema = z.enum([
  "http",
  "client-live-websocket",
  "worker-control-websocket",
  "worker-log-stream",
  "terminal-relay",
  "remote-surface-relay",
  "tunnel-relay",
  "attachment-transfer",
  "code-relay",
  "project-share-relay",
  "other",
]);

const storageCategoryUsageSchema = z
  .object({
    category: accountStorageCategorySchema,
    logicalBytes: resourceUsageDecimalSchema,
    rowCount: resourceUsageDecimalSchema,
  })
  .strict();

const workerStorageUsageSchema = z
  .object({
    logicalBytes: resourceUsageDecimalSchema,
    objectCount: resourceUsageDecimalSchema,
  })
  .strict();

const bandwidthBreakdownSchema = z
  .object({
    channel: accountBandwidthChannelSchema,
    direction: accountBandwidthDirectionSchema,
    bytes: resourceUsageDecimalSchema,
    operationCount: resourceUsageDecimalSchema,
  })
  .strict();

export const accountResourceUsageSchema = z
  .object({
    measurement: z
      .object({
        basisVersion: z.string().trim().min(1).max(100),
        measuredAt: z.iso.datetime().nullable(),
        reconciledAt: z.iso.datetime().nullable(),
        status: accountResourceUsageStatusSchema,
      })
      .strict(),
    storage: z
      .object({
        server: z
          .object({
            accuracy: accountResourceUsageAccuracySchema,
            logicalBytes: resourceUsageDecimalSchema,
            rowCount: resourceUsageDecimalSchema,
            categories: z.array(storageCategoryUsageSchema).max(32),
          })
          .strict(),
        workerManaged: z
          .object({
            accuracy: accountResourceUsageAccuracySchema,
            attachmentSources: workerStorageUsageSchema,
            readyReplicas: workerStorageUsageSchema,
            logicalBytes: resourceUsageDecimalSchema,
          })
          .strict(),
      })
      .strict(),
    bandwidth: z
      .object({
        accuracy: accountResourceUsageAccuracySchema,
        measuredAt: z.iso.datetime().nullable(),
        periodStart: z.iso.datetime(),
        periodEnd: z.iso.datetime(),
        ingressBytes: resourceUsageDecimalSchema,
        egressBytes: resourceUsageDecimalSchema,
        operationCount: resourceUsageDecimalSchema,
        breakdown: z.array(bandwidthBreakdownSchema).max(64),
      })
      .strict(),
    limits: z
      .object({
        storageBytes: resourceUsageDecimalSchema.nullable(),
        bandwidthBytes: resourceUsageDecimalSchema.nullable(),
      })
      .strict()
      .nullable(),
    enforcement: z.literal("disabled"),
  })
  .strict();

export const accountResourceUsageHistoryMetricSchema = z.enum([
  "storage",
  "bandwidth",
]);

export const accountResourceUsageHistoryResolutionSchema = z.enum([
  "hour",
  "day",
]);

const MAX_HOURLY_HISTORY_MS = 31 * 24 * 60 * 60_000;
const MAX_DAILY_HISTORY_MS = 2 * 366 * 24 * 60 * 60_000;

export const accountResourceUsageHistoryQuerySchema = z
  .object({
    metric: accountResourceUsageHistoryMetricSchema,
    resolution: accountResourceUsageHistoryResolutionSchema,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict()
  .superRefine((query, context) => {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (to <= from) {
      context.addIssue({
        code: "custom",
        message: "History end must be after its start.",
        path: ["to"],
      });
      return;
    }
    const maximum =
      query.resolution === "hour"
        ? MAX_HOURLY_HISTORY_MS
        : MAX_DAILY_HISTORY_MS;
    if (to - from > maximum) {
      context.addIssue({
        code: "custom",
        message:
          query.resolution === "hour"
            ? "Hourly history is limited to 31 days."
            : "Daily history is limited to two years.",
        path: ["from"],
      });
    }
  });

const accountStorageHistoryPointSchema = z
  .object({
    bucketStart: z.iso.datetime(),
    logicalBytes: resourceUsageDecimalSchema,
    rowCount: resourceUsageDecimalSchema,
  })
  .strict();

const accountBandwidthHistoryPointSchema = z
  .object({
    bucketStart: z.iso.datetime(),
    bytes: resourceUsageDecimalSchema,
    operationCount: resourceUsageDecimalSchema,
  })
  .strict();

export const accountResourceUsageHistorySchema = z.discriminatedUnion(
  "metric",
  [
    z
      .object({
        metric: z.literal("storage"),
        resolution: accountResourceUsageHistoryResolutionSchema,
        from: z.iso.datetime(),
        to: z.iso.datetime(),
        status: accountResourceUsageStatusSchema,
        series: z
          .array(
            z
              .object({
                storageClass: accountStorageClassSchema,
                category: z.string().trim().min(1).max(100),
                accuracy: accountResourceUsageAccuracySchema,
                points: z.array(accountStorageHistoryPointSchema).max(744),
              })
              .strict(),
          )
          .max(32),
        limits: z.null(),
        enforcement: z.literal("disabled"),
      })
      .strict(),
    z
      .object({
        metric: z.literal("bandwidth"),
        resolution: accountResourceUsageHistoryResolutionSchema,
        from: z.iso.datetime(),
        to: z.iso.datetime(),
        status: accountResourceUsageStatusSchema,
        series: z
          .array(
            z
              .object({
                channel: accountBandwidthChannelSchema,
                direction: accountBandwidthDirectionSchema,
                accuracy: accountResourceUsageAccuracySchema,
                points: z.array(accountBandwidthHistoryPointSchema).max(744),
              })
              .strict(),
          )
          .max(32),
        limits: z.null(),
        enforcement: z.literal("disabled"),
      })
      .strict(),
  ],
);

export const accountLiveTrafficCursorSchema = z
  .string()
  .regex(/^\d+:\d+$/u, "Expected a live traffic cursor.");

export const accountLiveTrafficQuerySchema = z
  .object({
    after: accountLiveTrafficCursorSchema.optional(),
    epoch: z.uuid().optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (Boolean(query.after) !== Boolean(query.epoch)) {
      context.addIssue({
        code: "custom",
        message: "Live traffic epoch and cursor must be provided together.",
        path: query.after ? ["epoch"] : ["after"],
      });
    }
  });

const accountLiveTrafficCounterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const accountLiveTrafficSampleSchema = z
  .object({
    timestamp: z.iso.datetime(),
    uploadBytes: accountLiveTrafficCounterSchema,
    downloadBytes: accountLiveTrafficCounterSchema,
    httpRequests: accountLiveTrafficCounterSchema,
    websocketMessages: z
      .object({
        upload: accountLiveTrafficCounterSchema,
        download: accountLiveTrafficCounterSchema,
        total: accountLiveTrafficCounterSchema,
      })
      .strict(),
  })
  .strict();

export const accountLiveTrafficSchema = z
  .object({
    schemaVersion: z.literal(1),
    epoch: z.uuid(),
    cursor: accountLiveTrafficCursorSchema,
    instanceId: z.string().trim().min(1).max(100),
    scope: z.literal("current-server-instance"),
    sampleIntervalSeconds: z.literal(1),
    windowSeconds: z.literal(300),
    generatedAt: z.iso.datetime(),
    reset: z.boolean(),
    current: accountLiveTrafficSampleSchema,
    samples: z.array(accountLiveTrafficSampleSchema).max(300),
    measurement: z
      .object({
        basis: z.literal("application-payload"),
        directTrafficIncluded: z.literal(false),
        transportOverheadIncluded: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type AccountBandwidthChannel = z.infer<
  typeof accountBandwidthChannelSchema
>;
export type AccountBandwidthDirection = z.infer<
  typeof accountBandwidthDirectionSchema
>;
export type AccountResourceUsage = z.infer<typeof accountResourceUsageSchema>;
export type AccountResourceUsageHistory = z.infer<
  typeof accountResourceUsageHistorySchema
>;
export type AccountResourceUsageHistoryQuery = z.infer<
  typeof accountResourceUsageHistoryQuerySchema
>;
export type AccountLiveTraffic = z.infer<typeof accountLiveTrafficSchema>;
export type AccountLiveTrafficQuery = z.infer<
  typeof accountLiveTrafficQuerySchema
>;
export type AccountLiveTrafficSample = z.infer<
  typeof accountLiveTrafficSampleSchema
>;
