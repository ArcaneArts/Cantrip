import {
  workerEnrollmentExchangeSchema,
  workerEnrollmentResultSchema,
  type WorkerHeartbeat,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";
import { saveWorkerCredential } from "./credential-store.js";
import { workerLogError, workerLogger } from "./logger.js";

export async function enrollWorker(
  config: WorkerConfig,
  heartbeat: WorkerHeartbeat,
): Promise<void> {
  if (!config.enrollmentCode) {
    workerLogger.event("debug", "Existing worker credential selected", {
      event: "worker.enrollment.not-required",
      subsystem: "worker-auth",
      operation: "enroll",
      status: "skipped",
      workerId: config.workerId,
      credentialState: config.tokenSource,
    });
    return;
  }
  const startedAtMs = Date.now();
  workerLogger.event("info", "Worker enrollment started", {
    event: "worker.enrollment.started",
    subsystem: "worker-auth",
    operation: "enroll",
    status: "started",
    workerId: config.workerId,
    serverOrigin: new URL(config.serverUrl).origin,
  });
  let response: Response;
  try {
    response = await fetch(`${config.serverUrl}/api/internal/workers/enroll`, {
      body: JSON.stringify(
        workerEnrollmentExchangeSchema.parse({
          code: config.enrollmentCode,
          heartbeat,
        }),
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    workerLogger.event("error", "Worker enrollment request failed", {
      event: "worker.enrollment.failed",
      subsystem: "worker-auth",
      operation: "enroll",
      reasonCode: "request-failed",
      status: "failed",
      durationMs: Date.now() - startedAtMs,
      workerId: config.workerId,
      error: workerLogError(error),
    });
    throw error;
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Cantrip Server rejected worker enrollment with HTTP ${response.status}.`;
    workerLogger.event("warn", "Worker enrollment was rejected", {
      event: "worker.enrollment.rejected",
      subsystem: "worker-auth",
      operation: "enroll",
      reasonCode: `http-${response.status}`,
      status: "rejected",
      durationMs: Date.now() - startedAtMs,
      workerId: config.workerId,
      httpStatus: response.status,
    });
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
  workerLogger.event("info", "Worker enrollment completed", {
    event: "worker.enrollment.completed",
    subsystem: "worker-auth",
    operation: "enroll",
    status: "completed",
    durationMs: Date.now() - startedAtMs,
    workerId: config.workerId,
    credentialState: "persisted",
  });
}
