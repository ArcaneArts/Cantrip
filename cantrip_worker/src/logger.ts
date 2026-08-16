import { createServiceLogger, ServiceLogBuffer } from "@cantrip/logging";
import type { WorkerLogReadQuery } from "@cantrip/protocol";

const workerLogBuffer = new ServiceLogBuffer();

export const workerLogger = createServiceLogger("worker", {
  onRecord: (record) => workerLogBuffer.append(record),
});

export function readWorkerLogs(query: WorkerLogReadQuery) {
  return workerLogBuffer.read(query);
}
