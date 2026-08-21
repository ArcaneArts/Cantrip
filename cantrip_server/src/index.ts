import { randomUUID } from "node:crypto";

import { buildApp } from "./app.js";
import {
  readServerConfig,
  resolveCodeSurfaceConfig,
  resolveServerDataDirectory,
} from "./config.js";
import {
  closeCodeSurfaceServer,
  CodeTunnelBroker,
  createCodeSurfaceServer,
} from "./code/tunnel.js";
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

async function listenCodeSurface(
  server: ReturnType<typeof createCodeSurfaceServer>,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

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
  const surfaceConfig = resolveCodeSurfaceConfig(config);
  const codeTunnel = new CodeTunnelBroker(workerBridge, {
    allowedFrameAncestors: config.appOrigins,
    consumeRelayBytes: (ownerId, workerId, bytes) =>
      relayQuotas.consumeRelay(ownerId, workerId, bytes),
    surfaceOrigin: surfaceConfig.origin,
  });
  const projectShareTunnel = new ProjectShareTunnelBroker(workerBridge, {
    surfaceOrigin: surfaceConfig.origin,
  });
  const app = await buildApp({
    codeTunnel,
    config,
    coordinator,
    database,
    projectShareTunnel,
    relayQuotas,
    workerBridge,
  });
  const codeSurface = createCodeSurfaceServer(
    codeTunnel,
    surfaceConfig.origin,
    projectShareTunnel,
  );
  let closing = false;
  let codeSurfaceListening = false;

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
    try {
      if (codeSurfaceListening) {
        await closeCodeSurfaceServer(codeSurface);
        codeSurfaceListening = false;
      }
    } finally {
      await app.close();
      serverLogger.event("info", "Cantrip Server shutdown completed", {
        event: "server.shutdown.completed",
        subsystem: "server-lifecycle",
        operation: "shutdown",
        status: "stopped",
        durationMs: Date.now() - shutdownStartedAtMs,
      });
      await closeServerLogArchive();
    }
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  try {
    await listenCodeSurface(
      codeSurface,
      surfaceConfig.host,
      surfaceConfig.port,
    );
    codeSurfaceListening = true;
  } catch (error) {
    await app.close();
    throw error;
  }
  serverLogger.event("info", "Cantrip Code isolated surface is ready", {
    event: "server.startup.code-surface-ready",
    subsystem: "server-lifecycle",
    operation: "listen-code-surface",
    status: "ready",
  });
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
