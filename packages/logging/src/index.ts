import { STATUS_CODES } from "node:http";

import {
  sanitizeLogRecordInput,
  type ServiceLogLevel,
  type ServiceLogRecordInput,
} from "./records.js";

export * from "./records.js";
export * from "./rotating-jsonl.js";

export type { ServiceLogLevel } from "./records.js";

export type ServiceLogContext = Error | Record<string, unknown> | unknown;

type LogOutput = (line: string, level: ServiceLogLevel) => void;

export type ServiceLogFormatterOptions = {
  colors?: boolean;
  now?: () => Date;
  onRecord?: (record: ServiceLogRecordInput) => void;
  output?: LogOutput;
};

type PinoEntry = Record<string, unknown> & {
  level?: number;
  msg?: string;
  req?: { method?: string; url?: string };
  reqId?: string;
  res?: { statusCode?: number };
  responseTime?: number;
  time?: number;
};

const ANSI = {
  blue: "\u001b[34m",
  brightBlue: "\u001b[94m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  white: "\u001b[97m",
  yellow: "\u001b[33m",
} as const;

const STANDARD_PINO_FIELDS = new Set([
  "hostname",
  "level",
  "msg",
  "pid",
  "reqId",
  "time",
  "v",
]);

function environmentUsesColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== "0";
  }
  return Boolean(process.stdout.isTTY);
}

function paint(
  value: string,
  color: keyof typeof ANSI,
  colors: boolean,
): string {
  return colors ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

function systemColor(system: string): keyof typeof ANSI {
  if (system === "server") return "brightBlue";
  if (system === "worker") return "magenta";
  return "blue";
}

function statusColor(statusCode: number): keyof typeof ANSI {
  if (statusCode >= 500) return "red";
  if (statusCode >= 300) return "yellow";
  return "green";
}

function formatClock(value: Date): string {
  return `${value.getHours().toString().padStart(2, "0")}:${value
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "?";
  if (durationMs < 0.5) {
    return `${Math.max(1, Math.floor(durationMs * 1_000))}µs`;
  }
  return `${Math.max(1, Math.floor(durationMs))}ms`;
}

function formatPrefix(
  system: string,
  timestamp: Date,
  colors: boolean,
): string {
  return `${paint(`[${system}]`, systemColor(system), colors)} ${paint(
    `${formatClock(timestamp)}:`,
    "gray",
    colors,
  )}`;
}

function renderPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const normalized = oneLine(value);
    return /\s/u.test(normalized) ? `“${normalized}”` : normalized;
  }
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function flattenContext(
  value: unknown,
  prefix: string,
  output: string[],
  depth = 0,
): void {
  if (value instanceof Error) {
    output.push(`${prefix || "error"}=${renderPrimitive(value.message)}`);
    return;
  }
  if (Array.isArray(value)) {
    output.push(`${prefix}=[${value.map(renderPrimitive).join(", ")}]`);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const errorMessage =
      typeof Reflect.get(value, "message") === "string" &&
      (prefix === "err" || prefix === "error")
        ? String(Reflect.get(value, "message"))
        : null;
    if (errorMessage) {
      output.push(`error=${renderPrimitive(errorMessage)}`);
      return;
    }
    if (depth >= 2) {
      output.push(`${prefix}={${entries.map(([key]) => key).join(", ")}}`);
      return;
    }
    for (const [key, nested] of entries) {
      if (STANDARD_PINO_FIELDS.has(key) || key === "stack" || key === "type") {
        continue;
      }
      flattenContext(
        nested,
        prefix ? `${prefix}.${key}` : key,
        output,
        depth + 1,
      );
    }
    return;
  }
  output.push(`${prefix || "value"}=${renderPrimitive(value)}`);
}

function contextSuffix(context: ServiceLogContext): string {
  if (context === undefined) return "";
  const fields: string[] = [];
  flattenContext(context, "", fields);
  return fields.length > 0 ? ` · ${fields.join(" ")}` : "";
}

function levelFromPino(level = 30): ServiceLogLevel {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  if (level >= 20) return "debug";
  return "trace";
}

function levelLabel(level: ServiceLogLevel): string | null {
  if (level === "info") return null;
  if (level === "fatal" || level === "error") return "ERROR";
  if (level === "warn") return "WARN";
  return "DEBUG";
}

function levelColor(level: ServiceLogLevel): keyof typeof ANSI {
  if (level === "fatal" || level === "error") return "red";
  if (level === "warn") return "yellow";
  return "gray";
}

export function formatServiceLog(input: {
  colors?: boolean;
  context?: ServiceLogContext;
  level?: ServiceLogLevel;
  message: string;
  system: string;
  timestamp?: Date;
}): string {
  const colors = input.colors ?? environmentUsesColor();
  const level = input.level ?? "info";
  const label = levelLabel(level);
  const prefix = formatPrefix(
    input.system,
    input.timestamp ?? new Date(),
    colors,
  );
  const labelText = label ? `${paint(label, levelColor(level), colors)} ` : "";
  const messageColor = level === "info" ? "white" : levelColor(level);
  return `${prefix} ${labelText}${paint(oneLine(input.message), messageColor, colors)}${paint(
    contextSuffix(input.context),
    "gray",
    colors,
  )}`;
}

export function formatHttpLog(input: {
  colors?: boolean;
  durationMs: number;
  method: string;
  path: string;
  statusCode: number;
  system: string;
  timestamp?: Date;
}): string {
  const colors = input.colors ?? environmentUsesColor();
  const status = `${input.statusCode} ${STATUS_CODES[input.statusCode] ?? "Unknown"}`;
  return `${formatPrefix(
    input.system,
    input.timestamp ?? new Date(),
    colors,
  )} ${paint(input.method, "blue", colors)} ${paint(
    input.path,
    "white",
    colors,
  )} ${paint("->", "gray", colors)} ${paint(
    status,
    statusColor(input.statusCode),
    colors,
  )} ${paint(`(${formatDuration(input.durationMs)})`, "gray", colors)}`;
}

function defaultOutput(line: string, level: ServiceLogLevel): void {
  const destination =
    level === "warn" || level === "error" || level === "fatal"
      ? process.stderr
      : process.stdout;
  destination.write(`${line}\n`);
}

export function createServiceLogger(
  system: string,
  options: ServiceLogFormatterOptions = {},
) {
  const colors = options.colors ?? environmentUsesColor();
  const now = options.now ?? (() => new Date());
  const onRecord = options.onRecord;
  const output = options.output ?? defaultOutput;
  const write = (
    level: ServiceLogLevel,
    message: string,
    context?: ServiceLogContext,
  ) => {
    const timestamp = now();
    output(
      formatServiceLog({
        colors,
        context,
        level,
        message,
        system,
        timestamp,
      }),
      level,
    );
    onRecord?.(
      sanitizeLogRecordInput({
        timestamp: timestamp.toISOString(),
        system,
        level,
        message,
        ...(context === undefined ? {} : { context }),
      }),
    );
  };
  return {
    debug: (message: string, context?: ServiceLogContext) =>
      write("debug", message, context),
    error: (message: string, context?: ServiceLogContext) =>
      write("error", message, context),
    info: (message: string, context?: ServiceLogContext) =>
      write("info", message, context),
    warn: (message: string, context?: ServiceLogContext) =>
      write("warn", message, context),
  };
}

export function createPinoServiceLogStream(
  system: string,
  options: ServiceLogFormatterOptions = {},
): { write(line: string): void } {
  const colors = options.colors ?? environmentUsesColor();
  const now = options.now ?? (() => new Date());
  const onRecord = options.onRecord;
  const output = options.output ?? defaultOutput;
  const pendingRequests = new Map<string, { method: string; path: string }>();

  return {
    write(line: string) {
      for (const candidate of line.split("\n")) {
        if (!candidate.trim()) continue;
        let entry: PinoEntry;
        try {
          entry = JSON.parse(candidate) as PinoEntry;
        } catch {
          const timestamp = now();
          output(
            formatServiceLog({
              colors,
              level: "info",
              message: candidate,
              system,
              timestamp,
            }),
            "info",
          );
          onRecord?.(
            sanitizeLogRecordInput({
              timestamp: timestamp.toISOString(),
              system,
              level: "info",
              message: candidate,
            }),
          );
          continue;
        }

        const timestamp =
          typeof entry.time === "number" ? new Date(entry.time) : now();
        const level = levelFromPino(entry.level);
        if (
          entry.msg === "incoming request" &&
          entry.reqId &&
          entry.req?.method &&
          entry.req.url
        ) {
          pendingRequests.set(entry.reqId, {
            method: entry.req.method,
            path: entry.req.url,
          });
          continue;
        }

        const request = entry.reqId
          ? pendingRequests.get(entry.reqId)
          : undefined;
        const statusCode = entry.res?.statusCode;
        if (
          request &&
          typeof statusCode === "number" &&
          typeof entry.responseTime === "number" &&
          (entry.msg === "request completed" || entry.msg === "request errored")
        ) {
          pendingRequests.delete(entry.reqId!);
          output(
            formatHttpLog({
              colors,
              durationMs: entry.responseTime,
              method: request.method,
              path: request.path,
              statusCode,
              system,
              timestamp,
            }),
            statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : level,
          );
          const recordLevel =
            statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : level;
          onRecord?.(
            sanitizeLogRecordInput({
              timestamp: timestamp.toISOString(),
              system,
              level: recordLevel,
              message: `${request.method} ${request.path} -> ${statusCode} ${STATUS_CODES[statusCode] ?? "Unknown"} (${formatDuration(entry.responseTime)})`,
              context: {
                durationMs: entry.responseTime,
                method: request.method,
                path: request.path,
                statusCode,
              },
            }),
          );
          continue;
        }

        output(
          formatServiceLog({
            colors,
            context: entry,
            level,
            message: entry.msg ?? "Log event",
            system,
            timestamp,
          }),
          level,
        );
        onRecord?.(
          sanitizeLogRecordInput({
            timestamp: timestamp.toISOString(),
            system,
            level,
            message: entry.msg ?? "Log event",
            context: entry,
          }),
        );
      }
    },
  };
}
