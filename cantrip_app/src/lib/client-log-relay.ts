import {
  sanitizeLogContext,
  ServiceLogBuffer,
  type ServiceLogLevel,
  type ServiceLogReadOptions,
  type ServiceLogReadResult,
} from "@cantrip/logging/records";
import {
  createServiceLogEmitter,
  type OperationalLogContext,
} from "@cantrip/logging/core";

type ClientConsoleLevel = "debug" | "error" | "info" | "log" | "trace" | "warn";

const MAX_MESSAGE_LENGTH = 16_384;
const captureState = globalThis as typeof globalThis & {
  __CANTRIP_CLIENT_LOG_CAPTURE__?: {
    buffer: ServiceLogBuffer;
    installed: boolean;
    originalConsole?: Record<
      ClientConsoleLevel,
      (...values: unknown[]) => void
    >;
  };
};

function state() {
  return (captureState.__CANTRIP_CLIENT_LOG_CAPTURE__ ??= {
    buffer: new ServiceLogBuffer(),
    installed: false,
  });
}

function serializeLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value === undefined) return "undefined";
  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (item instanceof Error) {
          return {
            message: item.message,
            name: item.name,
          };
        }
        if (typeof item === "bigint") return `${item.toString()}n`;
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      }) ?? String(value)
    );
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable value]";
    }
  }
}

export function formatClientLogArguments(values: readonly unknown[]): string {
  const message = values.map(serializeLogValue).join(" ");
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH)}… [truncated]`;
}

function serviceLevel(level: ClientConsoleLevel): ServiceLogLevel {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  if (level === "debug" || level === "trace") return "debug";
  return "info";
}

function consoleLevel(level: ServiceLogLevel): ClientConsoleLevel {
  if (level === "fatal" || level === "error") return "error";
  if (level === "warn") return "warn";
  if (level === "debug") return "debug";
  if (level === "trace") return "trace";
  return "info";
}

function clientConsoleLine(
  level: ServiceLogLevel,
  message: string,
  context?: unknown,
): string {
  const label = level === "info" ? "" : ` ${level.toUpperCase()}`;
  const suffix =
    context === undefined ? "" : ` ${formatClientLogArguments([context])}`;
  return `[client]${label} ${message}${suffix}`;
}

/** Deliberate operational logger. Its sanitized record feeds console and Logs. */
export const clientLogger = createServiceLogEmitter("client", {
  onRecord: (record) => state().buffer.append(record),
  output: (record) => {
    const level = consoleLevel(record.level);
    const writer = state().originalConsole?.[level] ?? console[level];
    writer(clientConsoleLine(record.level, record.message, record.context));
  },
});

export function logClientEvent(
  level: ServiceLogLevel,
  message: string,
  context: OperationalLogContext,
): void {
  clientLogger.event(level, message, context);
}

export function recordClientLog(
  level: ClientConsoleLevel,
  values: readonly unknown[],
  source?: string,
): void {
  state().buffer.append({
    timestamp: new Date().toISOString(),
    system: "client",
    level: serviceLevel(level),
    message: formatClientLogArguments(values.map(sanitizeLogContext)),
    ...(source ? { context: { source } } : {}),
  });
}

export function readClientLogs(
  options: ServiceLogReadOptions = {},
): ServiceLogReadResult {
  return state().buffer.read(options);
}

export function clearClientLogs(): void {
  state().buffer.clear();
}

export function installClientLogCapture(): void {
  const current = state();
  if (current.installed) return;
  current.installed = true;

  const originalConsole: Record<
    ClientConsoleLevel,
    (...values: unknown[]) => void
  > = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  };
  current.originalConsole = originalConsole;

  for (const level of Object.keys(originalConsole) as ClientConsoleLevel[]) {
    console[level] = (...values: unknown[]) => {
      const sanitizedValues = values.map(sanitizeLogContext);
      originalConsole[level](...sanitizedValues);
      recordClientLog(level, sanitizedValues);
    };
  }

  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent) {
        recordClientLog(
          "error",
          ["Uncaught client error", event.error ?? event.message],
          event.filename
            ? `${event.filename}:${event.lineno}:${event.colno}`
            : undefined,
        );
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      recordClientLog(
        "error",
        [`Failed to load client resource <${target.tagName.toLowerCase()}>`],
        target.getAttribute("src") ??
          target.getAttribute("href") ??
          window.location.href,
      );
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    recordClientLog("error", [
      "Unhandled client promise rejection",
      event.reason,
    ]);
  });
}
