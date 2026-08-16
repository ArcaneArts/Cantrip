import {
  createPinoServiceLogStream,
  createServiceLogger,
  RotatingJsonlLog,
  ServiceLogBuffer,
  type ServiceLogRecordInput,
  type ServiceLogFormatterOptions,
} from "@cantrip/logging";

const serverLogBuffer = new ServiceLogBuffer();
const configuredLogFile = process.env.CANTRIP_SERVICE_LOG_FILE?.trim();
const serverLogFile = configuredLogFile
  ? new RotatingJsonlLog({ filePath: configuredLogFile })
  : null;

function captureServerLog(record: ServiceLogRecordInput): void {
  const stored = serverLogBuffer.append(record);
  serverLogFile?.write(stored);
}

export const serverLogger = createServiceLogger("server", {
  onRecord: captureServerLog,
});

export function createServerLogStream(options?: ServiceLogFormatterOptions): {
  write(line: string): void;
} {
  return createPinoServiceLogStream("server", {
    ...options,
    onRecord(record) {
      captureServerLog(record);
      options?.onRecord?.(record);
    },
  });
}
