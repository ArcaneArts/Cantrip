import {
  createServiceLogger,
  RotatingJsonlLog,
  ServiceLogBuffer,
} from "@cantrip/logging";
import type { WorkerLogReadQuery } from "@cantrip/protocol";

const workerLogBuffer = new ServiceLogBuffer();
const configuredLogFile = process.env.CANTRIP_SERVICE_LOG_FILE?.trim();
const workerLogFile = configuredLogFile
  ? new RotatingJsonlLog({ filePath: configuredLogFile })
  : null;

export const workerLogger = createServiceLogger("worker", {
  onRecord(record) {
    const stored = workerLogBuffer.append(record);
    workerLogFile?.write(stored);
  },
});

export function readWorkerLogs(query: WorkerLogReadQuery) {
  return workerLogBuffer.read(query);
}
