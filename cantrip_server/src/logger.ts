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

export const SERVER_LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-cantrip-csrf",
  "req.headers.x-cantrip-bootstrap-token",
  "req.body.code",
  "req.body.credential",
  "req.body.apiKey",
  "req.body.enrollmentCode",
  "req.body.password",
  "req.body.accessToken",
  "req.body.refreshToken",
  "req.body.idToken",
  "req.body.summary",
  "req.body.bodyMarkdown",
  "req.body.briefMarkdown",
  "req.body.planMarkdown",
  "req.body.finalPlanMarkdown",
  "req.body.goalPrompt",
  "req.body.questions",
  "req.body.answers",
  "req.body.additionalDirection",
  "res.headers.set-cookie",
] as const;

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
