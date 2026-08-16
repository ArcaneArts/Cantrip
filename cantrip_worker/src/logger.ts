import {
  createServiceLogger,
  RotatingJsonlLog,
  ServiceLogBuffer,
  type ServiceLogContext,
  type ServiceLogLevel,
  type ServiceLogRecordInput,
} from "@cantrip/logging";
import type { WorkerLogReadQuery } from "@cantrip/protocol";

const workerLogBuffer = new ServiceLogBuffer();
const configuredLogFile = process.env.CANTRIP_SERVICE_LOG_FILE?.trim();
const workerLogFile = configuredLogFile
  ? new RotatingJsonlLog({ filePath: configuredLogFile })
  : null;

function storeWorkerLogRecord(record: ServiceLogRecordInput) {
  const stored = workerLogBuffer.append(record);
  workerLogFile?.write(stored);
}

export const workerLogger = createServiceLogger("worker", {
  onRecord: storeWorkerLogRecord,
});

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
