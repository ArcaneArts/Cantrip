import {
  cantripVersionSchema,
  operationalProbeSchema,
  serverBootstrapSchema,
  systemHealthSchema,
} from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";
import type { FastifyInstance } from "fastify";

import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import type { AccountUsageHistoryMaintenanceService } from "../../account-usage/history-maintenance.js";
import type { StorageReconciliationService } from "../../account-usage/storage-reconciler.js";
import { authenticationState, principalOwnerId } from "../../auth/principal.js";
import { safeSecretMatch } from "../../auth/service.js";
import type { ServerConfig } from "../../config.js";
import type { RelayCoordinator } from "../../coordination/relay-coordinator.js";
import type { DatabaseConnection } from "../../db/index.js";
import type { ServerRepository } from "../../db/repository.js";
import type { AppLiveHub } from "../../live/hub.js";
import type { OperationalMetrics } from "../../operations/metrics.js";
import type { RelayQuotaManager } from "../../operations/relay-quotas.js";
import type { TunnelRuntimeManager } from "../../tunnels/runtime.js";
import type { WorkerLinkRelay } from "../../worker-links/relay.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

export interface SystemStatusRouteDependencies {
  accountUsageMeter: Pick<AccountUsageMeter, "stats">;
  bridge: Pick<LimitedWorkerCommandBus, "stats">;
  config: ServerConfig;
  coordinationStats: () => ReturnType<RelayCoordinator["stats"]>;
  coordinator: Pick<RelayCoordinator, "health"> | undefined;
  database: Pick<DatabaseConnection, "engine" | "ping">;
  licenseWhitelistConfigured: boolean;
  licenseWhitelistEnabled: boolean;
  liveHub: Pick<AppLiveHub, "stats">;
  operationalMetrics: Pick<
    OperationalMetrics,
    "recordDatabaseProbe" | "renderPrometheus" | "snapshot"
  >;
  relayQuotas: Pick<RelayQuotaManager, "stats">;
  repository: Pick<ServerRepository, "countAccountUsers" | "onlineWorkerCount">;
  serverId: string;
  storageReconciler: Pick<StorageReconciliationService, "stats">;
  tunnelRuntime: Pick<TunnelRuntimeManager, "stats">;
  usageHistoryMaintenance: Pick<AccountUsageHistoryMaintenanceService, "stats">;
  workerLinkRelay: Pick<WorkerLinkRelay, "stats">;
}

/** Registers version, bootstrap, health, readiness, and metrics routes. */
export function installSystemStatusRoutes(
  app: FastifyInstance,
  {
    accountUsageMeter,
    bridge,
    config,
    coordinationStats,
    coordinator,
    database,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveHub,
    operationalMetrics,
    relayQuotas,
    repository,
    serverId,
    storageReconciler,
    tunnelRuntime,
    usageHistoryMaintenance,
    workerLinkRelay,
  }: SystemStatusRouteDependencies,
): void {
  app.get("/version", (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=300")
      .send(cantripVersionSchema.parse(cantripVersion)),
  );

  app.get("/api/bootstrap", async (request, reply) => {
    const accountCount =
      config.authMode === "accounts" ? await repository.countAccountUsers() : 0;
    const firstAccount = config.authMode === "accounts" && accountCount === 0;
    return reply.header("cache-control", "no-store").send(
      serverBootstrapSchema.parse({
        protocolVersion: 1,
        server: {
          id: serverId,
          version: cantripVersion,
          deploymentMode: config.deploymentMode,
          bootstrapMode: config.bootstrapMode,
        },
        auth: {
          mode: config.authMode,
          state: authenticationState(request.principal),
          currentUser: request.principal.user,
          registration: {
            enabled:
              config.authMode === "accounts" &&
              (licenseWhitelistConfigured ||
                Boolean(config.publicRegistration) ||
                (firstAccount && Boolean(config.adminBootstrapToken))),
            bootstrapRequired:
              !licenseWhitelistConfigured &&
              firstAccount &&
              !Boolean(config.publicRegistration),
            licenseRequired: licenseWhitelistEnabled,
          },
        },
        routing: {
          workerConnection: "server-only",
          directWorkerConnections: false,
        },
        storage: {
          conversations: "server",
          files: "worker",
        },
        agent: {
          model: config.agentModel,
          modelProvider: config.agentModelProvider,
        },
        capabilities: {
          accounts: config.authMode === "accounts",
          passwordProtection: config.authMode === "password",
          linkCodes: true,
          multipleWorkers: true,
          projectReplicas: true,
          replicaProvisioning: true,
          browserFleetDiscovery: true,
          crossWorkerExecutionTargets: true,
          remoteDesktopFleet: true,
          workerSwitching: true,
          gitSync: true,
          worktrees: true,
          standaloneChat: {
            available: true,
            protocolVersion: 1,
            reason: null,
          },
          remoteSurfaces: {
            enabled: true,
            transports: config.remoteSurfaceWebRtc
              ? ["websocket", "webrtc"]
              : ["websocket"],
            relayOnly:
              config.remoteSurfaceWebRtc?.iceTransportPolicy === "relay",
          },
          code: {
            enabled: true,
            transport: "web-proxy",
            isolatedOrigin: true,
          },
        },
      }),
    );
  });

  app.get("/api/health", { logLevel: "warn" }, async (request, reply) => {
    const probeStartedAt = performance.now();
    await database.ping();
    operationalMetrics.recordDatabaseProbe(
      true,
      performance.now() - probeStartedAt,
    );
    const ownerId = principalOwnerId(request);
    const bandwidthMeterStats = accountUsageMeter.stats();
    const historyMaintenanceStats = usageHistoryMaintenance.stats();
    const storageReconciliationStats = storageReconciler.stats();
    return reply.send(
      systemHealthSchema.parse({
        status: "ok",
        service: "cantrip_server",
        database: { engine: database.engine, ready: true },
        workers: {
          connected: await repository.onlineWorkerCount(ownerId),
        },
        live: liveHub.stats(),
        operations: {
          ...operationalMetrics.snapshot(),
          instanceId: config.serverInstanceId ?? "local-single-instance",
          coordination: coordinationStats(),
          quotas: relayQuotas.stats(),
          tunnels: tunnelRuntime.stats(),
          workerLinkRelay: workerLinkRelay.stats(),
          workerCommands: bridge.stats(),
          accountUsage: {
            bandwidthMeter: {
              bufferedBytes: bandwidthMeterStats.bufferedBytes.toString(),
              bufferedEntries: bandwidthMeterStats.bufferedEntries,
              droppedBytes: bandwidthMeterStats.droppedBytes.toString(),
              droppedMeasurements:
                bandwidthMeterStats.droppedMeasurements.toString(),
              flushCount: bandwidthMeterStats.flushCount,
              flushFailureCount: bandwidthMeterStats.flushFailureCount,
              lastFlushDurationMs: bandwidthMeterStats.lastFlushDurationMs,
              lastFlushedAt: bandwidthMeterStats.lastFlushedAt,
            },
            historyMaintenance: {
              completionCount: historyMaintenanceStats.completionCount,
              failureCount: historyMaintenanceStats.failureCount,
              lastCompletedAt: historyMaintenanceStats.lastCompletedAt,
              lastDurationMs: historyMaintenanceStats.lastDurationMs,
              lastErrorAt: historyMaintenanceStats.lastErrorAt,
              lastSuccessfulAt: historyMaintenanceStats.lastSuccessfulAt,
              leaseContentionCount:
                historyMaintenanceStats.leaseContentionCount,
              running: historyMaintenanceStats.running,
              totals: {
                accountCount: historyMaintenanceStats.totals.accountCount,
                logicalServerBytes:
                  historyMaintenanceStats.totals.logicalServerBytes.toString(),
                logicalWorkerManagedBytes:
                  historyMaintenanceStats.totals.logicalWorkerManagedBytes.toString(),
                physicalDatabaseBytes:
                  historyMaintenanceStats.totals.physicalDatabaseBytes?.toString() ??
                  null,
              },
            },
            storageReconciliation: {
              completionCount: storageReconciliationStats.completionCount,
              failureCount: storageReconciliationStats.failureCount,
              lastCompletedAt: storageReconciliationStats.lastCompletedAt,
              lastDurationMs: storageReconciliationStats.lastDurationMs,
              lastErrorAt: storageReconciliationStats.lastErrorAt,
              lastSuccessfulAt: storageReconciliationStats.lastSuccessfulAt,
              leaseContentionCount:
                storageReconciliationStats.leaseContentionCount,
              running: storageReconciliationStats.running,
            },
          },
        },
        timestamp: new Date().toISOString(),
      }),
    );
  });

  app.get("/healthz", { logLevel: "warn" }, (_request, reply) =>
    reply.send(
      operationalProbeSchema.parse({
        status: "alive",
        service: "cantrip_server",
        timestamp: new Date().toISOString(),
      }),
    ),
  );

  app.get("/readyz", { logLevel: "warn" }, async (_request, reply) => {
    const startedAt = performance.now();
    let databaseReady = false;
    let coordinationReady = !coordinator;
    try {
      await database.ping();
      databaseReady = true;
      coordinationReady = (await coordinator?.health()) ?? true;
      if (!coordinationReady) {
        throw new Error("Shared coordination is unavailable.");
      }
      const latencyMs = performance.now() - startedAt;
      operationalMetrics.recordDatabaseProbe(true, latencyMs);
      return reply.send(
        operationalProbeSchema.parse({
          status: "ready",
          service: "cantrip_server",
          database: { engine: database.engine, status: "ready", latencyMs },
          coordination: {
            shared: Boolean(coordinator),
            status: "ready",
          },
          timestamp: new Date().toISOString(),
        }),
      );
    } catch {
      const latencyMs = performance.now() - startedAt;
      operationalMetrics.recordDatabaseProbe(databaseReady, latencyMs);
      return reply.code(503).send(
        operationalProbeSchema.parse({
          status: "not-ready",
          service: "cantrip_server",
          database: {
            engine: database.engine,
            status: databaseReady ? "ready" : "unavailable",
            latencyMs,
          },
          coordination: {
            shared: Boolean(coordinator),
            status: coordinationReady ? "ready" : "unavailable",
          },
          timestamp: new Date().toISOString(),
        }),
      );
    }
  });

  app.get("/metrics", { logLevel: "warn" }, (request, reply) => {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    const tokenAuthorized = Boolean(
      config.metricsToken &&
      bearer &&
      safeSecretMatch(bearer, config.metricsToken),
    );
    const accountAuthorized =
      request.principal.state === "authenticated" &&
      ["owner", "admin"].includes(request.principal.user.role);
    if (!tokenAuthorized && !accountAuthorized) {
      reply.header("www-authenticate", 'Bearer realm="Cantrip metrics"');
      return reply.code(401).send({ error: "Metrics authorization required." });
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(
      operationalMetrics.renderPrometheus({
        accountUsage: {
          bandwidthMeter: accountUsageMeter.stats(),
          historyMaintenance: usageHistoryMaintenance.stats(),
          storageReconciliation: storageReconciler.stats(),
        },
        coordination: coordinationStats(),
        live: liveHub.stats(),
        quotas: relayQuotas.stats(),
        tunnels: tunnelRuntime.stats(),
        workers: bridge.stats(),
      }),
    );
  });
}
