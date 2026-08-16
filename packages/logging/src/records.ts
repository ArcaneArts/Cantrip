export const SERVICE_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type ServiceLogLevel = (typeof SERVICE_LOG_LEVELS)[number];

export type ServiceLogRecordInput = {
  timestamp: string;
  system: string;
  level: ServiceLogLevel;
  message: string;
  context?: unknown;
};

export type ServiceLogRecord = ServiceLogRecordInput & {
  cursor: number;
};

export type ServiceLogReadOptions = {
  afterCursor?: number;
  limit?: number;
  minimumLevel?: ServiceLogLevel;
};

export type ServiceLogReadResult = {
  records: ServiceLogRecord[];
  nextCursor: number;
  oldestCursor: number | null;
  latestCursor: number;
  hasMore: boolean;
  truncated: boolean;
};

export type ServiceLogBufferOptions = {
  maxBytes?: number;
  maxEntries?: number;
  maxRecordBytes?: number;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024;
const MAX_CONTEXT_DEPTH = 6;
const MAX_CONTEXT_ENTRIES = 100;
const MAX_STRING_LENGTH = 16_384;
const REDACTED = "[REDACTED]";

const LEVEL_WEIGHT: Record<ServiceLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const SECRET_FIELD_SEGMENT =
  /^(?:authorization|cookie|password|passwd|passphrase|secret|api-key|apikey|token|access-token|refresh-token|bearer-token|private-key|credential|pairing-code|enrollment-code)$/iu;
const AUTH_HEADER =
  /\bauthorization(\s*[=:]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const AUTH_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const NAMED_SECRET =
  /\b(authorization|cookie|password|passwd|passphrase|secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|private[_-]?key|pairing[_-]?code|enrollment[_-]?code)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu;
const PROVIDER_TOKEN =
  /\b(?:sk|gh[opusr]|xox[baprs]|pat)[-_][A-Za-z0-9_-]{8,}\b/gu;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const CONTROL_SEQUENCE =
  /(?:\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])/gu;

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Log buffer limits must be positive safe integers.");
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSecretField(value: string): boolean {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[_.\s]+/gu, "-")
    .toLowerCase();
  return SECRET_FIELD_SEGMENT.test(normalized);
}

function truncateText(
  value: string,
  maximumLength = MAX_STRING_LENGTH,
): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretField(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return candidate;
  }
}

export function sanitizeLogText(value: string): string {
  return truncateText(
    value
      .replace(CONTROL_SEQUENCE, "")
      .replace(
        AUTH_HEADER,
        (_match, separator: string) => `Authorization${separator}${REDACTED}`,
      )
      .replace(AUTH_VALUE, (match) => `${match.split(/\s/u, 1)[0]} ${REDACTED}`)
      .replace(
        NAMED_SECRET,
        (_match, name: string, separator: string) =>
          `${name}${separator}${REDACTED}`,
      )
      .replace(PROVIDER_TOKEN, REDACTED)
      .replace(URL_PATTERN, redactUrl),
  );
}

function sanitizeUnknown(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeLogText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_CONTEXT_DEPTH) return "[Truncated]";
  if (value instanceof Error) {
    return {
      name: sanitizeLogText(value.name),
      message: sanitizeLogText(value.message),
      ...(value.stack ? { stack: sanitizeLogText(value.stack) } : {}),
    };
  }
  if (typeof value !== "object") return sanitizeLogText(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map((item) => sanitizeUnknown(item, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(
    0,
    MAX_CONTEXT_ENTRIES,
  )) {
    output[key] = isSecretField(key)
      ? REDACTED
      : sanitizeUnknown(nested, depth + 1, seen);
  }
  return output;
}

export function sanitizeLogContext(value: unknown): unknown {
  return sanitizeUnknown(value, 0, new WeakSet());
}

export function sanitizeLogRecordInput(
  input: ServiceLogRecordInput,
): ServiceLogRecordInput {
  return {
    timestamp: input.timestamp,
    system: sanitizeLogText(input.system),
    level: input.level,
    message: sanitizeLogText(input.message),
    ...(input.context === undefined
      ? {}
      : { context: sanitizeLogContext(input.context) }),
  };
}

function fitRecord(
  record: ServiceLogRecord,
  maxRecordBytes: number,
): { record: ServiceLogRecord; bytes: number } {
  let serialized = JSON.stringify(record);
  let bytes = byteLength(serialized);
  if (bytes <= maxRecordBytes) return { record, bytes };

  const withoutContext = { ...record, context: undefined };
  serialized = JSON.stringify(withoutContext);
  bytes = byteLength(serialized);
  if (bytes <= maxRecordBytes) return { record: withoutContext, bytes };

  let low = 0;
  let high = withoutContext.message.length;
  let fitted = { ...withoutContext, message: "" };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...withoutContext,
      message: `${withoutContext.message.slice(0, middle)}…`,
    };
    const candidateBytes = byteLength(JSON.stringify(candidate));
    if (candidateBytes <= maxRecordBytes) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { record: fitted, bytes: byteLength(JSON.stringify(fitted)) };
}

export class ServiceLogBuffer {
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #maxRecordBytes: number;
  readonly #entries: Array<{ bytes: number; record: ServiceLogRecord }> = [];
  #bytes = 0;
  #cursor = 0;

  constructor(options: ServiceLogBufferOptions = {}) {
    this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxRecordBytes = Math.min(
      positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES),
      this.#maxBytes,
    );
  }

  get byteSize(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.length;
  }

  get latestCursor(): number {
    return this.#cursor;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#bytes = 0;
  }

  append(input: ServiceLogRecordInput): ServiceLogRecord {
    const sanitized = sanitizeLogRecordInput(input);
    const candidate = { ...sanitized, cursor: ++this.#cursor };
    const fitted = fitRecord(candidate, this.#maxRecordBytes);
    this.#entries.push(fitted);
    this.#bytes += fitted.bytes;
    while (
      this.#entries.length > this.#maxEntries ||
      this.#bytes > this.#maxBytes
    ) {
      const removed = this.#entries.shift();
      if (!removed) break;
      this.#bytes -= removed.bytes;
    }
    return fitted.record;
  }

  read(options: ServiceLogReadOptions = {}): ServiceLogReadResult {
    const afterCursor = Math.max(0, Math.floor(options.afterCursor ?? 0));
    const limit = Math.min(500, positiveInteger(options.limit, 200));
    const minimumWeight = LEVEL_WEIGHT[options.minimumLevel ?? "trace"];
    const oldestCursor = this.#entries[0]?.record.cursor ?? null;
    const truncated =
      oldestCursor !== null &&
      afterCursor > 0 &&
      afterCursor < oldestCursor - 1;
    const records: ServiceLogRecord[] = [];
    let nextCursor = afterCursor;
    let stoppedAt = -1;
    for (let index = 0; index < this.#entries.length; index += 1) {
      const record = this.#entries[index]!.record;
      if (record.cursor <= afterCursor) continue;
      nextCursor = record.cursor;
      if (LEVEL_WEIGHT[record.level] >= minimumWeight) records.push(record);
      if (records.length >= limit) {
        stoppedAt = index;
        break;
      }
    }
    const hasMore = stoppedAt >= 0 && stoppedAt < this.#entries.length - 1;
    if (!hasMore && nextCursor < this.#cursor) nextCursor = this.#cursor;
    return {
      records,
      nextCursor,
      oldestCursor,
      latestCursor: this.#cursor,
      hasMore,
      truncated,
    };
  }
}
