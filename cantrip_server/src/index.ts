import { randomUUID } from "node:crypto";

import { buildApp } from "./app.js";
import { readServerConfig, resolveServerDataDirectory } from "./config.js";
import { CodeTunnelBroker } from "./code/tunnel.js";
import { connectDatabase } from "./db/index.js";
import { RedisRelayCoordinator } from "./coordination/relay-coordinator.js";
import { RelayQuotaManager } from "./operations/relay-quotas.js";
import {
  closeServerLogArchive,
  initializeServerLogArchive,
  serverLogger,
} from "./logger.js";
import { ProjectShareTunnelBroker } from "./project-shares/tunnel.js";
import { WorkerBridge } from "./workers/bridge.js";
import { CoordinatedWorkerBridge } from "./workers/coordinated-bridge.js";

async function start(): Promise<void> {
  const startedAtMs = Date.now();
  await initializeServerLogArchive(resolveServerDataDirectory());
  const config = readServerConfig();
  config.serverInstanceId ??= randomUUID();
  serverLogger.event("info", "Cantrip Server startup began", {
    event: "server.startup.started",
    subsystem: "server-lifecycle",
    operation: "start",
    status: "starting",
    deploymentMode: config.deploymentMode,
    databaseEngine: config.databaseUrl ? "postgres" : "pglite",
    sharedCoordination: Boolean(config.redisUrl),
  });
  const database = await connectDatabase(config);
  serverLogger.event("info", "Database is ready", {
    event: "server.startup.database-ready",
    subsystem: "server-lifecycle",
    operation: "connect-database",
    status: "ready",
    durationMs: Date.now() - startedAtMs,
    databaseEngine: database.engine,
  });
  const coordinator = config.redisUrl
    ? new RedisRelayCoordinator({
        instanceId: config.serverInstanceId,
        maximumInstances: config.coordinationMaxInstances,
        presenceTtlMs: config.coordinationPresenceTtlMs,
        url: config.redisUrl,
      })
    : undefined;
  await coordinator?.start();
  if (coordinator) {
    serverLogger.event("info", "Shared relay coordination is ready", {
      event: "coordination.lifecycle.ready",
      subsystem: "relay-coordination",
      operation: "start",
      status: "ready",
      counts: { instances: coordinator.stats().instanceCount },
    });
  }
  const workerBridge = coordinator
    ? new CoordinatedWorkerBridge({
        coordinator,
        resolveOwnerId: (workerId) =>
          database.repository.getWorkerOwnerId(workerId),
      })
    : new WorkerBridge();
  const relayQuotas = new RelayQuotaManager(config);
  const codeTunnel = new CodeTunnelBroker(workerBridge);
  const projectShareTunnel = new ProjectShareTunnelBroker(workerBridge);
  const app = await buildApp({
    codeTunnel,
    config,
    coordinator,
    database,
    projectShareTunnel,
    relayQuotas,
    workerBridge,
  });
  let closing = false;

  if (config.allowInsecureRemote) {
    app.log.warn(
      "CANTRIP_ALLOW_INSECURE_REMOTE is enabled for a non-hosted server; restrict network access explicitly.",
    );
  }

  const close = async (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }

    closing = true;
    const shutdownStartedAtMs = Date.now();
    serverLogger.event("info", "Cantrip Server shutdown began", {
      event: "server.shutdown.started",
      subsystem: "server-lifecycle",
      operation: "shutdown",
      reasonCode: signal.toLowerCase(),
      status: "stopping",
    });
    await app.close();
    serverLogger.event("info", "Cantrip Server shutdown completed", {
      event: "server.shutdown.completed",
      subsystem: "server-lifecycle",
      operation: "shutdown",
      status: "stopped",
      durationMs: Date.now() - shutdownStartedAtMs,
    });
    await closeServerLogArchive();
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  serverLogger.event("info", "Cantrip Server is ready", {
    event: "server.startup.completed",
    subsystem: "server-lifecycle",
    operation: "start",
    status: "ready",
    durationMs: Date.now() - startedAtMs,
    databaseEngine: database.engine,
    sharedCoordination: Boolean(coordinator),
  });
}

start().catch(async (error: unknown) => {
  serverLogger.event("fatal", "Cantrip Server failed to start", {
    event: "server.startup.failed",
    subsystem: "server-lifecycle",
    operation: "start",
    status: "failed",
    reasonCode: "startup-error",
    error: error instanceof Error ? error : new Error(String(error)),
  });
  await closeServerLogArchive();
  process.exitCode = 1;
});
