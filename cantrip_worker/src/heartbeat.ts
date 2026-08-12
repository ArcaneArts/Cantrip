import os from "node:os";

import {
  type CodeCapabilities,
  type CodexRuntimeReport,
  type DirectBrokerAdvertisement,
  type RemoteSurfaceCapabilities,
  type WorkerHeartbeat,
  unavailableCodeCapabilities,
  workerHeartbeatSchema,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";

export function createHeartbeat(
  config: WorkerConfig,
  codexRuntime: CodexRuntimeReport,
  startedAt: string,
  remoteSurfaces: RemoteSurfaceCapabilities = {
    browser: false,
    desktop: false,
    transports: ["websocket"],
    iceTransportPolicies: ["relay"],
    maxSessions: 4,
  },
  code: CodeCapabilities = unavailableCodeCapabilities,
  directBroker: DirectBrokerAdvertisement = { available: false },
): WorkerHeartbeat {
  return workerHeartbeatSchema.parse({
    workerId: config.workerId,
    name: config.name,
    platform: os.platform(),
    architecture: os.arch(),
    codexVersion: codexRuntime.version?.raw ?? null,
    codexRuntime,
    remoteSurfaces,
    code,
    directBroker,
    projectReplicas: {
      provision: true,
      synchronize: true,
      remove: true,
      exactRevision: true,
    },
    chatRelocation: true,
    startedAt,
  });
}

export async function sendHeartbeat(
  config: WorkerConfig,
  heartbeat: WorkerHeartbeat,
): Promise<void> {
  const response = await fetch(
    `${config.serverUrl}/api/internal/workers/heartbeat`,
    {
      body: JSON.stringify(heartbeat),
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(4_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Cantrip Server rejected heartbeat with HTTP ${response.status}.`,
    );
  }
}
