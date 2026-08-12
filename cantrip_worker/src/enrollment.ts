import {
  workerEnrollmentExchangeSchema,
  workerEnrollmentResultSchema,
  type WorkerHeartbeat,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";
import { saveWorkerCredential } from "./credential-store.js";

export async function enrollWorker(
  config: WorkerConfig,
  heartbeat: WorkerHeartbeat,
): Promise<void> {
  if (!config.enrollmentCode) return;
  const response = await fetch(
    `${config.serverUrl}/api/internal/workers/enroll`,
    {
      body: JSON.stringify(
        workerEnrollmentExchangeSchema.parse({
          code: config.enrollmentCode,
          heartbeat,
        }),
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Cantrip Server rejected worker enrollment with HTTP ${response.status}.`;
    throw new Error(message);
  }
  const enrolled = workerEnrollmentResultSchema.parse(payload);
  if (enrolled.worker.workerId !== config.workerId) {
    throw new Error("Cantrip Server returned a mismatched worker identity.");
  }
  saveWorkerCredential({
    credential: enrolled.credential,
    dataDirectory: config.dataDirectory,
    serverUrl: config.serverUrl,
    workerId: config.workerId,
  });
  config.token = enrolled.credential;
  config.tokenSource = "persisted";
  config.enrollmentCode = null;
}
