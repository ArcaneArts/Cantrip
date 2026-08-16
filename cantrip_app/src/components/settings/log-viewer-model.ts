import type {
  ServerBootstrap,
  ServiceLogLevel,
  ServiceLogRecord,
} from "@cantrip/protocol";

import type { ServerConnection } from "@/lib/server-connections";

export const SERVICE_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const satisfies readonly ServiceLogLevel[];

export const MAX_VIEWER_LOG_RECORDS = 10_000;
export const MAX_VIEWER_LOG_BYTES = 5 * 1024 * 1024;

export type ViewerLogRecord = ServiceLogRecord & {
  viewerBytes: number;
  viewerKey: string;
};

export type LogViewport = {
  height: number;
  scrollTop: number;
};

export function scheduleLogViewportScroll(
  target: { readonly scrollTop: number },
  schedule: (update: (current: LogViewport) => LogViewport) => void,
): void {
  const scrollTop = target.scrollTop;
  schedule((current) => ({ ...current, scrollTop }));
}

const levelWeight: Record<ServiceLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function origin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function canReadLocalServerLogs(input: {
  bootstrap: ServerBootstrap | null | undefined;
  connection: ServerConnection | null;
  localServerUrl: string | null | undefined;
  tauriRuntime: boolean;
}): boolean {
  return Boolean(
    input.tauriRuntime &&
    input.connection?.kind === "local" &&
    input.bootstrap?.server.deploymentMode === "local" &&
    input.bootstrap.server.bootstrapMode === "tauri" &&
    origin(input.connection.url) !== null &&
    origin(input.connection.url) === origin(input.localServerUrl),
  );
}

function contextText(context: unknown): string {
  if (context === undefined || context === null) return "";
  try {
    return JSON.stringify(context);
  } catch {
    return "[context unavailable]";
  }
}

export function formatServiceLogRecord(record: ServiceLogRecord): string {
  const timestamp = new Date(record.timestamp);
  const time = Number.isNaN(timestamp.getTime())
    ? record.timestamp
    : timestamp.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      });
  const context = contextText(record.context);
  return `${time} ${record.system.padEnd(8)} ${record.level.toUpperCase().padEnd(5)} ${record.message}${context ? ` ${context}` : ""}`;
}

export function filterServiceLogRecords(
  records: readonly ViewerLogRecord[],
  search: string,
  minimumLevel: ServiceLogLevel,
): ViewerLogRecord[] {
  const needle = search.trim().toLocaleLowerCase();
  const threshold = levelWeight[minimumLevel];
  return records.filter((record) => {
    if (levelWeight[record.level] < threshold) return false;
    if (!needle) return true;
    return formatServiceLogRecord(record).toLocaleLowerCase().includes(needle);
  });
}

export function appendServiceLogRecords(
  previous: readonly ViewerLogRecord[],
  incoming: readonly ServiceLogRecord[],
  transport: string,
): ViewerLogRecord[] {
  const byKey = new Map(previous.map((record) => [record.viewerKey, record]));
  for (const record of incoming) {
    const viewerKey = `${transport}:${record.cursor}`;
    const viewerBytes =
      record.message.length + contextText(record.context).length + 160;
    byKey.set(viewerKey, { ...record, viewerBytes, viewerKey });
  }
  const records = [...byKey.values()].sort((left, right) => {
    const time = left.timestamp.localeCompare(right.timestamp);
    return time || left.viewerKey.localeCompare(right.viewerKey);
  });
  let bytes = records.reduce((total, record) => total + record.viewerBytes, 0);
  while (
    records.length > MAX_VIEWER_LOG_RECORDS ||
    bytes > MAX_VIEWER_LOG_BYTES
  ) {
    bytes -= records.shift()?.viewerBytes ?? 0;
  }
  return records;
}
