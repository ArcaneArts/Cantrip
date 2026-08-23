import {
  createServiceLogger,
  normalizeLogError,
  ServiceLogBuffer,
  type ServiceLogContext,
  type ServiceLogLevel,
  type ServiceLogRecordInput,
} from "@cantrip/logging";
import type { DailyLogArchive } from "@cantrip/logging/archive";
import { createNodeDailyLogArchive } from "@cantrip/logging/node";
import type { WorkerLogReadQuery } from "@cantrip/protocol";
import type { ServiceLogRecord } from "@cantrip/protocol";
import path from "node:path";

const workerLogBuffer = new ServiceLogBuffer();
const workerLogListeners = new Set<(record: ServiceLogRecord) => void>();
let workerLogArchive: DailyLogArchive | null = null;
let lastArchiveDiagnosticAt = 0;

const SAFE_ERROR_CLASSES = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WorkerUnavailableError",
  "ZodError",
]);
const SAFE_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "EACCES",
  "EADDRINUSE",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOENT",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_STATE",
  "ERR_SOCKET_CLOSED",
]);

function storeWorkerLogRecord(record: ServiceLogRecordInput) {
  const stored = workerLogBuffer.append(record);
  void workerLogArchive?.append(stored);
  for (const listener of workerLogListeners) {
    try {
      listener(stored);
    } catch {
      // Log capture must not fail because an optional live reader failed.
    }
  }
}

export async function initializeWorkerLogArchive(
  dataDirectory: string,
): Promise<void> {
  const configuredDirectory = process.env.CANTRIP_SERVICE_LOG_DIR?.trim();
  const configuredFile = process.env.CANTRIP_SERVICE_LOG_FILE?.trim();
  const directory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : configuredFile
      ? path.dirname(path.resolve(configuredFile))
      : path.join(dataDirectory, "logs");
  workerLogArchive = createNodeDailyLogArchive({
    directory,
    legacyFileNames: configuredFile
      ? [path.basename(configuredFile)]
      : ["worker.jsonl", "worker.service.jsonl"],
    onDiagnostic({ error, operation }) {
      const now = Date.now();
      if (now - lastArchiveDiagnosticAt < 30_000) return;
      lastArchiveDiagnosticAt = now;
      process.stderr.write(
        `[worker] WARN Service log archive ${operation} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
    source: "worker",
  });
  await workerLogArchive.initialize();
}

export async function closeWorkerLogArchive(): Promise<void> {
  const archive = workerLogArchive;
  workerLogArchive = null;
  await archive?.close();
}

export const workerLogger = createServiceLogger("worker", {
  onRecord: storeWorkerLogRecord,
});

export function workerLogError(error: unknown) {
  return normalizeLogError(error);
}

/**
 * Returns only stable error identity fields for security-sensitive transport
 * diagnostics. Error messages are intentionally excluded because they can
 * contain worker-local paths or protected target material.
 */
export function workerLogErrorIdentity(error: unknown) {
  const normalized = normalizeLogError(error);
  const errorClass = SAFE_ERROR_CLASSES.has(normalized.name)
    ? normalized.name
    : "Error";
  const errorCode =
    normalized.code && SAFE_ERROR_CODES.has(normalized.code)
      ? normalized.code
      : undefined;
  return {
    errorClass,
    ...(errorCode ? { errorCode } : {}),
  };
}

/**
 * Mirrors an already-emitted worker diagnostic into the service log stream.
 * Unlike workerLogger, this does not write to stdout/stderr again.
 */
export function captureWorkerDiagnostic(
  level: ServiceLogLevel,
  message: string,
  context?: ServiceLogContext,
) {
  storeWorkerLogRecord({
    timestamp: new Date().toISOString(),
    system: "worker",
    level,
    message,
    ...(context === undefined ? {} : { context }),
  });
}

export function readWorkerLogs(query: WorkerLogReadQuery) {
  return workerLogBuffer.read(query);
}

export function subscribeWorkerLogs(
  listener: (record: ServiceLogRecord) => void,
): () => void {
  workerLogListeners.add(listener);
  return () => workerLogListeners.delete(listener);
}
