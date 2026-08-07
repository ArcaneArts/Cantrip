import os from "node:os";

import { type WorkerHeartbeat, workerHeartbeatSchema } from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";

export function createHeartbeat(
  config: WorkerConfig,
  codexVersion: string | null,
  startedAt: string,
): WorkerHeartbeat {
  return workerHeartbeatSchema.parse({
    workerId: config.workerId,
    name: config.name,
    platform: os.platform(),
    architecture: os.arch(),
    codexVersion,
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
