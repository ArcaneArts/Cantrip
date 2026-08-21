import {
  createPinoServiceLogStream,
  createServiceLogger,
  ServiceLogBuffer,
  type ServiceLogRecordInput,
  type ServiceLogFormatterOptions,
} from "@cantrip/logging";
import { createNodeDailyLogArchive } from "@cantrip/logging/node";
import type { DailyLogArchive } from "@cantrip/logging/archive";
import path from "node:path";

const serverLogBuffer = new ServiceLogBuffer();
let serverLogArchive: DailyLogArchive | null = null;
let lastArchiveDiagnosticAt = 0;

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
  void serverLogArchive?.append(stored);
}

export async function initializeServerLogArchive(
  dataDirectory: string,
): Promise<void> {
  const configuredDirectory = process.env.CANTRIP_SERVICE_LOG_DIR?.trim();
  const configuredFile = process.env.CANTRIP_SERVICE_LOG_FILE?.trim();
  const directory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : configuredFile
      ? path.dirname(path.resolve(configuredFile))
      : path.join(dataDirectory, "logs");
  serverLogArchive = createNodeDailyLogArchive({
    directory,
    legacyFileNames: configuredFile
      ? [path.basename(configuredFile)]
      : ["server.jsonl", "server.service.jsonl"],
    onDiagnostic({ error, operation }) {
      const now = Date.now();
      if (now - lastArchiveDiagnosticAt < 30_000) return;
      lastArchiveDiagnosticAt = now;
      process.stderr.write(
        `[server] WARN Service log archive ${operation} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
    source: "server",
  });
  await serverLogArchive.initialize();
}

export async function closeServerLogArchive(): Promise<void> {
  const archive = serverLogArchive;
  serverLogArchive = null;
  await archive?.close();
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
