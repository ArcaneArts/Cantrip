import os from "node:os";

import {
  type CodeCapabilities,
  type CodeGraphWorkerStatus,
  type CodexRuntimeReport,
  type DirectBrokerAdvertisement,
  type ProjectReplicaCapabilities,
  type RemoteSurfaceCapabilities,
  type WorkerHeartbeat,
  type WorkerEncryptionStatus,
  unavailableCodeCapabilities,
  unavailableCodeGraphWorkerStatus,
  unavailableWorkerEncryptionStatus,
  workerHeartbeatSchema,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";

const HEARTBEAT_TIMEOUT_MS = 15_000;

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
  codegraph: CodeGraphWorkerStatus = unavailableCodeGraphWorkerStatus,
  encryption: WorkerEncryptionStatus = unavailableWorkerEncryptionStatus,
  projectReplicas: ProjectReplicaCapabilities = {
    provision: true,
    synchronize: true,
    remove: true,
    exactRevision: true,
    directPlacement: true,
    managedLinkPlacement: false,
    attachExisting: true,
    recursiveParentCreation: true,
  },
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
    projectReplicas,
    managedFolders: {
      create: true,
      attachExisting: true,
      convertToGithub: true,
      remove: true,
    },
    standaloneChat: {
      protocolVersion: 1,
      scratch: {
        provision: true,
        resolve: true,
        archive: true,
        restore: true,
        remove: true,
        reconcile: true,
        routingHandles: true,
      },
      files: {
        list: false,
        read: false,
        write: false,
        remove: false,
        download: false,
        archive: false,
      },
    },
    chatRelocation: true,
    externalCodexHistory:
      process.platform === "darwin" || process.platform === "win32",
    codegraph,
    encryption,
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
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Cantrip Server rejected heartbeat with HTTP ${response.status}.`,
    );
  }
}
