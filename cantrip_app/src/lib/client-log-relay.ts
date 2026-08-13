import { invoke, isTauri } from "@tauri-apps/api/core";

type ClientLogLevel = "debug" | "error" | "info" | "log" | "trace" | "warn";

const MAX_MESSAGE_LENGTH = 16_384;
const relayState = globalThis as typeof globalThis & {
  __CANTRIP_CLIENT_LOG_RELAY_INSTALLED__?: boolean;
};

function serializeLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`;
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
            stack: item.stack,
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

export function installDesktopClientLogRelay(): void {
  // Tauri debug builds install the same relay before any frontend module runs.
  // This remains the fallback for development shells without that early hook.
  if (
    !import.meta.env.DEV ||
    !isTauri() ||
    relayState.__CANTRIP_CLIENT_LOG_RELAY_INSTALLED__
  ) {
    return;
  }
  relayState.__CANTRIP_CLIENT_LOG_RELAY_INSTALLED__ = true;

  const originalConsole: Record<
    ClientLogLevel,
    (...values: unknown[]) => void
  > = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  };
  const relay = (
    level: ClientLogLevel,
    values: readonly unknown[],
    source?: string,
  ) => {
    const message = formatClientLogArguments(values);
    void invoke("relay_client_log", { level, message, source }).catch(
      (error) => {
        originalConsole.warn("Could not relay a client log to devtop.", error);
      },
    );
  };

  for (const level of Object.keys(originalConsole) as ClientLogLevel[]) {
    console[level] = (...values: unknown[]) => {
      originalConsole[level](...values);
      relay(level, values);
    };
  }

  window.addEventListener("error", (event) => {
    relay(
      "error",
      [
        `Uncaught client error at ${event.filename || "unknown source"}:${event.lineno}:${event.colno}`,
        event.error ?? event.message,
      ],
      event.filename || undefined,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    relay("error", ["Unhandled client promise rejection", event.reason]);
  });
}
