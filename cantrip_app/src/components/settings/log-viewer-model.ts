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

type ViewerLogCollectionMetadata = {
  bytes: number;
  maxCursorByTransport: ReadonlyMap<string, number>;
  sorted: boolean;
  unique: boolean;
};

export type LogViewport = {
  height: number;
  scrollTop: number;
};

const viewerLogCollectionMetadata = new WeakMap<
  readonly ViewerLogRecord[],
  ViewerLogCollectionMetadata
>();
// Log collections are immutable snapshots. Keeping derived metadata on their
// array identity makes the next append incremental without extending UI state,
// and lets garbage collection reclaim snapshots and metadata together.

export function scheduleLogViewportScroll(
  target: { readonly scrollTop: number },
  schedule: (update: (current: LogViewport) => LogViewport) => void,
): void {
  const scrollTop = target.scrollTop;
  schedule((current) => ({ ...current, scrollTop }));
}

export function shouldLoadOlderLogs(input: {
  hasOlder: boolean;
  loadingOlder: boolean;
  scrollTop: number;
  threshold: number;
}): boolean {
  return (
    input.hasOlder && !input.loadingOlder && input.scrollTop <= input.threshold
  );
}

export function restoredLogScrollTop(input: {
  nextScrollHeight: number;
  previousScrollHeight: number;
  previousScrollTop: number;
}): number {
  return Math.max(
    0,
    input.previousScrollTop +
      Math.max(0, input.nextScrollHeight - input.previousScrollHeight),
  );
}

export function shouldStopFollowingLogs(input: {
  clientHeight: number;
  followTail: boolean;
  scrollHeight: number;
  scrollTop: number;
  threshold: number;
}): boolean {
  return (
    input.followTail &&
    input.scrollHeight - input.clientHeight - input.scrollTop > input.threshold
  );
}

export function shouldJumpToNewestLogs(input: {
  direction: "backward" | "forward";
  hasMore: boolean;
  truncated: boolean;
}): boolean {
  return input.direction === "forward" && (input.hasMore || input.truncated);
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

export function formatServiceLogRecords(
  records: readonly ViewerLogRecord[],
): string {
  return records.map(formatServiceLogRecord).join("\n");
}

export function filterServiceLogRecords(
  records: readonly ViewerLogRecord[],
  search: string,
  minimumLevel: ServiceLogLevel,
): readonly ViewerLogRecord[] {
  const needle = search.trim().toLocaleLowerCase();
  const threshold = levelWeight[minimumLevel];
  if (!needle && threshold === levelWeight.trace) return records;
  return records.filter((record) => {
    if (levelWeight[record.level] < threshold) return false;
    if (!needle) return true;
    return formatServiceLogRecord(record).toLocaleLowerCase().includes(needle);
  });
}

function compareViewerLogRecords(
  left: ViewerLogRecord,
  right: ViewerLogRecord,
): number {
  const time = left.timestamp.localeCompare(right.timestamp);
  return time || left.viewerKey.localeCompare(right.viewerKey);
}

function viewerLogTransport(record: ViewerLogRecord): string {
  const cursorSuffix = `:${record.cursor}`;
  return record.viewerKey.endsWith(cursorSuffix)
    ? record.viewerKey.slice(0, -cursorSuffix.length)
    : record.viewerKey;
}

function readViewerLogCollectionMetadata(
  records: readonly ViewerLogRecord[],
): ViewerLogCollectionMetadata {
  const cached = viewerLogCollectionMetadata.get(records);
  if (cached) return cached;

  let bytes = 0;
  let sorted = true;
  let unique = true;
  const keys = new Set<string>();
  const maxCursorByTransport = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    bytes += record.viewerBytes;
    if (keys.has(record.viewerKey)) unique = false;
    else keys.add(record.viewerKey);
    if (index > 0 && compareViewerLogRecords(records[index - 1]!, record) > 0) {
      sorted = false;
    }
    const transport = viewerLogTransport(record);
    maxCursorByTransport.set(
      transport,
      Math.max(maxCursorByTransport.get(transport) ?? -1, record.cursor),
    );
  }
  const metadata = { bytes, maxCursorByTransport, sorted, unique };
  viewerLogCollectionMetadata.set(records, metadata);
  return metadata;
}

function cacheViewerLogCollection(
  records: ViewerLogRecord[],
  bytes: number,
  maxCursorByTransport: ReadonlyMap<string, number>,
): ViewerLogRecord[] {
  viewerLogCollectionMetadata.set(records, {
    bytes,
    maxCursorByTransport,
    sorted: true,
    unique: true,
  });
  return records;
}

function trimServiceLogRecords(
  records: ViewerLogRecord[],
  bytes: number,
): { bytes: number; records: ViewerLogRecord[] } {
  let start = Math.max(0, records.length - MAX_VIEWER_LOG_RECORDS);
  for (let index = 0; index < start; index += 1) {
    bytes -= records[index]!.viewerBytes;
  }
  while (start < records.length && bytes > MAX_VIEWER_LOG_BYTES) {
    bytes -= records[start]!.viewerBytes;
    start += 1;
  }
  return {
    bytes,
    records: start === 0 ? records : records.slice(start),
  };
}

function mergeSortedServiceLogRecords(
  previous: readonly ViewerLogRecord[],
  incoming: readonly ViewerLogRecord[],
): ViewerLogRecord[] {
  const merged = new Array<ViewerLogRecord>(previous.length + incoming.length);
  let previousIndex = 0;
  let incomingIndex = 0;
  let mergedIndex = 0;
  while (previousIndex < previous.length && incomingIndex < incoming.length) {
    const previousRecord = previous[previousIndex]!;
    const incomingRecord = incoming[incomingIndex]!;
    if (compareViewerLogRecords(previousRecord, incomingRecord) <= 0) {
      merged[mergedIndex] = previousRecord;
      previousIndex += 1;
    } else {
      merged[mergedIndex] = incomingRecord;
      incomingIndex += 1;
    }
    mergedIndex += 1;
  }
  while (previousIndex < previous.length) {
    merged[mergedIndex] = previous[previousIndex]!;
    previousIndex += 1;
    mergedIndex += 1;
  }
  while (incomingIndex < incoming.length) {
    merged[mergedIndex] = incoming[incomingIndex]!;
    incomingIndex += 1;
    mergedIndex += 1;
  }
  return merged;
}

export function appendServiceLogRecords(
  previous: readonly ViewerLogRecord[],
  incoming: readonly ServiceLogRecord[],
  transport: string,
): readonly ViewerLogRecord[] {
  const previousMetadata = readViewerLogCollectionMetadata(previous);
  const incomingByKey = new Map<string, ViewerLogRecord>();
  for (const record of incoming) {
    const viewerKey = `${transport}:${record.cursor}`;
    const viewerBytes =
      record.message.length + contextText(record.context).length + 160;
    incomingByKey.set(viewerKey, { ...record, viewerBytes, viewerKey });
  }
  if (incomingByKey.size === 0) {
    if (
      previousMetadata.sorted &&
      previousMetadata.unique &&
      previous.length <= MAX_VIEWER_LOG_RECORDS &&
      previousMetadata.bytes <= MAX_VIEWER_LOG_BYTES
    ) {
      return previous;
    }
    const byKey = new Map(previous.map((record) => [record.viewerKey, record]));
    const normalized = [...byKey.values()].sort(compareViewerLogRecords);
    const normalizedBytes = normalized.reduce(
      (total, record) => total + record.viewerBytes,
      0,
    );
    const trimmed = trimServiceLogRecords(normalized, normalizedBytes);
    return cacheViewerLogCollection(
      trimmed.records,
      trimmed.bytes,
      readViewerLogCollectionMetadata(trimmed.records).maxCursorByTransport,
    );
  }

  const incomingRecords = [...incomingByKey.values()].sort(
    compareViewerLogRecords,
  );
  const incomingBytes = incomingRecords.reduce(
    (total, record) => total + record.viewerBytes,
    0,
  );
  const currentTransportMax =
    previousMetadata.maxCursorByTransport.get(transport);
  const containsOnlyNewCursors =
    currentTransportMax === undefined ||
    incomingRecords.every((record) => record.cursor > currentTransportMax);
  const followsPrevious =
    previous.length === 0 ||
    compareViewerLogRecords(
      previous[previous.length - 1]!,
      incomingRecords[0]!,
    ) <= 0;

  let records: ViewerLogRecord[];
  let bytes = previousMetadata.bytes + incomingBytes;
  if (
    previousMetadata.sorted &&
    previousMetadata.unique &&
    containsOnlyNewCursors &&
    followsPrevious
  ) {
    records = previous.concat(incomingRecords);
  } else if (previousMetadata.sorted && previousMetadata.unique) {
    const retainedPrevious: ViewerLogRecord[] = [];
    for (const record of previous) {
      if (incomingByKey.has(record.viewerKey)) {
        bytes -= record.viewerBytes;
      } else {
        retainedPrevious.push(record);
      }
    }
    records = mergeSortedServiceLogRecords(retainedPrevious, incomingRecords);
  } else {
    const byKey = new Map(previous.map((record) => [record.viewerKey, record]));
    for (const [viewerKey, record] of incomingByKey) {
      byKey.set(viewerKey, record);
    }
    records = [...byKey.values()].sort(compareViewerLogRecords);
    bytes = records.reduce((total, record) => total + record.viewerBytes, 0);
  }

  const maxCursorByTransport = new Map(previousMetadata.maxCursorByTransport);
  for (const record of incomingRecords) {
    maxCursorByTransport.set(
      transport,
      Math.max(maxCursorByTransport.get(transport) ?? -1, record.cursor),
    );
  }
  const trimmed = trimServiceLogRecords(records, bytes);
  return cacheViewerLogCollection(
    trimmed.records,
    trimmed.bytes,
    maxCursorByTransport,
  );
}

export function removeServiceLogRecords(
  previous: readonly ViewerLogRecord[],
  removedKeys: ReadonlySet<string>,
): readonly ViewerLogRecord[] {
  if (removedKeys.size === 0 || previous.length === 0) return previous;
  const previousMetadata = readViewerLogCollectionMetadata(previous);
  let bytes = previousMetadata.bytes;
  const retained: ViewerLogRecord[] = [];
  for (const record of previous) {
    if (removedKeys.has(record.viewerKey)) {
      bytes -= record.viewerBytes;
    } else {
      retained.push(record);
    }
  }
  if (retained.length === previous.length) return previous;
  viewerLogCollectionMetadata.set(retained, {
    ...previousMetadata,
    bytes,
  });
  return retained;
}
