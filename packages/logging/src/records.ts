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

export type NormalizedLogError = {
  code?: string;
  message: string;
  name: string;
};

export type ServiceLogRecord = ServiceLogRecordInput & {
  cursor: number;
};

export type ServiceLogReadOptions = {
  afterCursor?: number;
  beforeCursor?: number;
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
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|passphrase|secret|client-secret|api-key|apikey|token|access-token|refresh-token|id-token|bearer-token|provider-token|private-key|credential|csrf|csrf-token|xsrf-token|device-code|oauth-code|pairing-code|enrollment-code|signed-url)$/iu;
const SIGNED_URL_QUERY_SEGMENT =
  /^(?:signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/iu;
const AUTH_HEADER =
  /\bauthorization(\s*[=:]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const AUTH_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const NAMED_SECRET =
  /\b(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|provider[_-]?token|private[_-]?key|credential|csrf(?:[_-]?token)?|xsrf[_-]?token|device[_-]?code|oauth[_-]?code|pairing[_-]?code|enrollment[_-]?code|signed[_-]?url)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu;
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
    const keys = [...url.searchParams.keys()];
    const signedUrl = keys.some((key) => SIGNED_URL_QUERY_SEGMENT.test(key));
    for (const key of keys) {
      if (signedUrl || isSecretField(key)) url.searchParams.set(key, REDACTED);
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

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return sanitizeLogText(String(value));
}

/**
 * Converts thrown values to stable, bounded metadata. Stacks and causes are
 * deliberately excluded: they commonly contain paths, command arguments, and
 * provider payload fragments that do not belong in remotely readable logs.
 */
export function normalizeLogError(error: unknown): NormalizedLogError {
  if (error instanceof Error) {
    const candidateCode = Reflect.get(error, "code");
    const code = errorCode(candidateCode);
    return {
      name: sanitizeLogText(error.name || "Error"),
      message: sanitizeLogText(error.message || "Unknown error"),
      ...(code ? { code } : {}),
    };
  }
  if (error && typeof error === "object") {
    const name = Reflect.get(error, "name");
    const message = Reflect.get(error, "message");
    const code = errorCode(Reflect.get(error, "code"));
    return {
      name: sanitizeLogText(typeof name === "string" ? name : "Error"),
      message: sanitizeLogText(
        typeof message === "string" ? message : "Unknown error",
      ),
      ...(code ? { code } : {}),
    };
  }
  return {
    name: "Error",
    message: sanitizeLogText(
      error === undefined ? "Unknown error" : String(error),
    ),
  };
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
    return normalizeLogError(value);
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

const PERSISTED_STRING_CONTEXT_KEYS = new Set([
  "architecture",
  "attemptKind",
  "connectionScope",
  "errorClass",
  "errorCode",
  "event",
  "method",
  "mode",
  "observationTrigger",
  "operation",
  "path",
  "platform",
  "providerKind",
  "reasonCode",
  "status",
  "subsystem",
  "transportKind",
  "windowKind",
]);
const PERSISTED_DESTINATION_REJECTION_CODES = new Set([
  "target-unavailable",
  "target-rejected",
  "limit-exceeded",
  "unauthorized",
  "protocol-error",
  "congested",
  "protected-target-invalid",
  "protected-record-unavailable",
  "protected-endpoint-unavailable",
]);
const PERSISTED_NUMBER_CONTEXT_KEY =
  /(?:^attempt$|^durationMs$|^errorStatus$|^statusCode$|Count$|Bytes$|Ms$|Percent$|BasisPoints$)/u;
const PERSISTED_ID_CONTEXT_KEY = /Ids?$/u;
const PERSISTED_VERSION_CONTEXT_KEY = /Version$/u;
const PERSISTED_FAILURE_STAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function minimizeLogContext(
  value: unknown,
): Record<string, unknown> | undefined {
  const sanitized = sanitizeLogContext(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return undefined;
  }
  const source = sanitized as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (key === "failureStage") {
      if (
        typeof nested === "string" &&
        nested.length <= 100 &&
        PERSISTED_FAILURE_STAGE.test(nested)
      ) {
        output.failureStage = nested;
      }
      continue;
    }
    if (key === "lastDestinationRejectionCode") {
      if (
        typeof nested === "string" &&
        PERSISTED_DESTINATION_REJECTION_CODES.has(nested)
      ) {
        output.lastDestinationRejectionCode = nested;
      }
      continue;
    }
    if (key === "path") {
      if (typeof nested === "string" && nested.startsWith("/api/")) {
        output.path = truncateText(nested, 512);
      }
      continue;
    }
    if (
      typeof nested === "string" &&
      (PERSISTED_STRING_CONTEXT_KEYS.has(key) ||
        PERSISTED_ID_CONTEXT_KEY.test(key) ||
        PERSISTED_VERSION_CONTEXT_KEY.test(key))
    ) {
      output[key] = truncateText(nested, 512);
      continue;
    }
    if (
      typeof nested === "number" &&
      Number.isFinite(nested) &&
      PERSISTED_NUMBER_CONTEXT_KEY.test(key)
    ) {
      output[key] = nested;
      continue;
    }
    if (
      typeof nested === "boolean" &&
      /^(?:active|enabled|success)$/u.test(key)
    ) {
      output[key] = nested;
    }
  }
  const error = source.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.name === "string") {
      output.errorClass = truncateText(errorRecord.name, 128);
    }
    if (typeof errorRecord.code === "string") {
      output.errorCode = truncateText(errorRecord.code, 128);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * Reduces persisted and remotely readable logs to stable operational fields.
 * Human messages, arbitrary context, provider bodies, filesystem paths, and
 * thrown error messages remain console-only diagnostics.
 */
export function minimizeServiceLogRecordInput(
  input: ServiceLogRecordInput,
): ServiceLogRecordInput {
  const context = minimizeLogContext(input.context);
  const event = context?.event;
  return {
    timestamp: input.timestamp,
    system: sanitizeLogText(input.system),
    level: input.level,
    message:
      typeof event === "string"
        ? event
        : `${sanitizeLogText(input.system)}.diagnostic`,
    ...(context ? { context } : {}),
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
    const minimized = minimizeServiceLogRecordInput(input);
    const candidate = { ...minimized, cursor: ++this.#cursor };
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
    const beforeCursor =
      options.beforeCursor === undefined
        ? null
        : Math.max(1, Math.floor(options.beforeCursor));
    const limit = Math.min(500, positiveInteger(options.limit, 200));
    const minimumWeight = LEVEL_WEIGHT[options.minimumLevel ?? "trace"];
    const oldestCursor = this.#entries[0]?.record.cursor ?? null;
    if (beforeCursor !== null) {
      const records: ServiceLogRecord[] = [];
      let hasMore = false;
      for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
        const record = this.#entries[index]!.record;
        if (record.cursor >= beforeCursor) continue;
        if (LEVEL_WEIGHT[record.level] < minimumWeight) continue;
        if (records.length >= limit) {
          hasMore = true;
          break;
        }
        records.push(record);
      }
      records.reverse();
      return {
        records,
        nextCursor: this.#cursor,
        oldestCursor,
        latestCursor: this.#cursor,
        hasMore,
        truncated: !hasMore && oldestCursor !== null && oldestCursor > 1,
      };
    }
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
