import { randomUUID } from "node:crypto";

import { buildApp } from "./app.js";
import { readServerConfig, resolveCodeSurfaceConfig } from "./config.js";
import {
  closeCodeSurfaceServer,
  CodeTunnelBroker,
  createCodeSurfaceServer,
} from "./code/tunnel.js";
import { connectDatabase } from "./db/index.js";
import { RedisRelayCoordinator } from "./coordination/relay-coordinator.js";
import { RelayQuotaManager } from "./operations/relay-quotas.js";
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
  const config = readServerConfig();
  config.serverInstanceId ??= randomUUID();
  const database = await connectDatabase(config);
  const coordinator = config.redisUrl
    ? new RedisRelayCoordinator({
        instanceId: config.serverInstanceId,
        maximumInstances: config.coordinationMaxInstances,
        presenceTtlMs: config.coordinationPresenceTtlMs,
        url: config.redisUrl,
      })
    : undefined;
  await coordinator?.start();
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
    app.log.info({ signal }, "Shutting down Cantrip Server");
    try {
      if (codeSurfaceListening) {
        await closeCodeSurfaceServer(codeSurface);
        codeSurfaceListening = false;
      }
    } finally {
      await app.close();
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
  app.log.info(
    { origin: surfaceConfig.origin },
    "Cantrip Code isolated surface is ready",
  );
  app.log.info({ database: database.engine }, "Cantrip Server is ready");
}

start().catch((error: unknown) => {
  console.error("Cantrip Server failed to start", error);
  process.exitCode = 1;
});
