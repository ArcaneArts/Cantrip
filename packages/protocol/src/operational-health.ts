import { z } from "zod";

import { databaseEngineSchema } from "./protocol-core.js";
import { tunnelDataPlaneCloseCodeSchema } from "./tunnel-data-plane.js";

export const operationalProbeSchema = z.object({
  status: z.enum(["alive", "ready", "not-ready"]),
  service: z.literal("cantrip_server"),
  database: z
    .object({
      engine: databaseEngineSchema,
      status: z.enum(["ready", "unavailable"]),
      latencyMs: z.number().nonnegative(),
    })
    .optional(),
  coordination: z
    .object({
      shared: z.boolean(),
      status: z.enum(["ready", "unavailable"]),
    })
    .optional(),
  timestamp: z.string().datetime(),
});

const operationalCounterSchema = z.number().int().nonnegative();

export const serverOperationalStatsSchema = z.object({
  instanceId: z.string().min(1).max(100),
  uptimeSeconds: z.number().nonnegative(),
  http: z.object({
    activeRequests: operationalCounterSchema,
    requestCount: operationalCounterSchema,
  }),
  legacyFeatureTransports: z
    .object({
      requestsByEndpoint: z.object({
        "remote-surface-transport": operationalCounterSchema,
        "terminal-direct": operationalCounterSchema,
        "terminal-relay": operationalCounterSchema,
        "tunnel-direct": operationalCounterSchema,
        "tunnel-direct-activate": operationalCounterSchema,
        "tunnel-relay": operationalCounterSchema,
      }),
    })
    .optional(),
  coordination: z.object({
    cachedWorkers: operationalCounterSchema,
    instanceCount: operationalCounterSchema,
    maximumInstances: z.number().int().positive(),
    receivedMessages: operationalCounterSchema,
    rejectedMessages: operationalCounterSchema,
    sentMessages: operationalCounterSchema,
    shared: z.boolean(),
  }),
  workerCommands: z.object({
    activeRequests: operationalCounterSchema,
    connectedWorkers: operationalCounterSchema,
    failedRequests: operationalCounterSchema,
    routedRequests: operationalCounterSchema,
    succeededRequests: operationalCounterSchema,
  }),
  workerLinkRelay: z
    .object({
      channels: operationalCounterSchema,
      connections: operationalCounterSchema,
      queuedBytes: operationalCounterSchema,
      queuedFrames: operationalCounterSchema,
      queuedFramesByLane: z.object({
        events: operationalCounterSchema,
        interactive: operationalCounterSchema,
        stream: operationalCounterSchema,
        realtime: operationalCounterSchema,
        bulk: operationalCounterSchema,
      }),
    })
    .optional(),
  tunnels: z.object({
    activeConnections: operationalCounterSchema,
    activeRoutes: operationalCounterSchema,
    bytesFromSource: operationalCounterSchema,
    bytesToSource: operationalCounterSchema,
    closedConnections: operationalCounterSchema,
    openedConnections: operationalCounterSchema,
    rejectedConnections: operationalCounterSchema,
    terminationsByReason: z.record(
      tunnelDataPlaneCloseCodeSchema,
      operationalCounterSchema,
    ),
  }),
  quotas: z.object({
    activeRemoteSurfaces: operationalCounterSchema,
    rejectedRelayBandwidth: operationalCounterSchema,
    rejectedRemoteSurfaces: operationalCounterSchema,
    rejectedUploads: operationalCounterSchema,
    relayBytes: operationalCounterSchema,
    uploadBytes: operationalCounterSchema,
  }),
  scheduler: z.object({
    dispatchFailures: operationalCounterSchema,
    dispatches: operationalCounterSchema,
    dueOccurrences: operationalCounterSchema,
    lastScanAt: z.string().datetime().nullable(),
    lastScanDurationSeconds: z.number().nonnegative(),
    leaseContentions: operationalCounterSchema,
    leaseRecoveries: operationalCounterSchema,
    maximumLagSeconds: z.number().nonnegative(),
    scanFailures: operationalCounterSchema,
    scans: operationalCounterSchema,
  }),
  accountUsage: z
    .object({
      bandwidthMeter: z.object({
        bufferedBytes: z.string().regex(/^\d+$/u),
        bufferedEntries: operationalCounterSchema,
        droppedBytes: z.string().regex(/^\d+$/u),
        droppedMeasurements: z.string().regex(/^\d+$/u),
        flushCount: operationalCounterSchema,
        flushFailureCount: operationalCounterSchema,
        lastFlushDurationMs: z.number().nonnegative().nullable(),
        lastFlushedAt: z.string().datetime().nullable(),
      }),
      historyMaintenance: z.object({
        completionCount: operationalCounterSchema,
        failureCount: operationalCounterSchema,
        lastCompletedAt: z.string().datetime().nullable(),
        lastDurationMs: z.number().nonnegative().nullable(),
        lastErrorAt: z.string().datetime().nullable(),
        lastSuccessfulAt: z.string().datetime().nullable(),
        leaseContentionCount: operationalCounterSchema,
        running: z.boolean(),
        totals: z.object({
          accountCount: operationalCounterSchema,
          logicalServerBytes: z.string().regex(/^\d+$/u),
          logicalWorkerManagedBytes: z.string().regex(/^\d+$/u),
          physicalDatabaseBytes: z.string().regex(/^\d+$/u).nullable(),
        }),
      }),
      storageReconciliation: z.object({
        completionCount: operationalCounterSchema,
        failureCount: operationalCounterSchema,
        lastCompletedAt: z.string().datetime().nullable(),
        lastDurationMs: z.number().nonnegative().nullable(),
        lastErrorAt: z.string().datetime().nullable(),
        lastSuccessfulAt: z.string().datetime().nullable(),
        leaseContentionCount: operationalCounterSchema,
        running: z.boolean(),
      }),
    })
    .optional(),
});

export const systemHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("cantrip_server"),
  database: z.object({
    engine: databaseEngineSchema,
    ready: z.boolean(),
  }),
  workers: z.object({
    connected: z.number().int().nonnegative(),
  }),
  live: z.object({
    acceptedConnectionCount: z.number().int().nonnegative(),
    connectionCount: z.number().int().nonnegative(),
    currentCursor: z.number().int().nonnegative(),
    deliveredEventCount: z.number().int().nonnegative(),
    disconnectedConnectionCount: z.number().int().nonnegative(),
    heartbeatPongCount: z.number().int().nonnegative(),
    heartbeatTimeoutCount: z.number().int().nonnegative(),
    protocolViolationCount: z.number().int().nonnegative(),
    publicationCount: z.number().int().nonnegative(),
    queuePressureCount: z.number().int().nonnegative(),
    replayEventCount: z.number().int().nonnegative(),
    replaySessionCount: z.number().int().nonnegative(),
    replayedEventCount: z.number().int().nonnegative(),
    resyncRequiredCount: z.number().int().nonnegative(),
    resumeAttemptCount: z.number().int().nonnegative(),
    serverEpoch: z.string().uuid(),
    slowConsumerClosureCount: z.number().int().nonnegative(),
  }),
  // Optional while clients and independently deployed servers roll across the
  // release that introduced operational counters.
  operations: serverOperationalStatsSchema.optional(),
  timestamp: z.string().datetime(),
});

export type SystemHealth = z.infer<typeof systemHealthSchema>;

export type OperationalProbe = z.infer<typeof operationalProbeSchema>;
