import { describe, expect, it } from "vitest";

import clientLogRelaySource from "../../src-tauri/src/client_log_relay.js?raw";
import {
  clientLogger,
  clearClientLogs,
  formatClientLogArguments,
  operationalErrorMetadata,
  readClientLogs,
  recordClientLog,
} from "./client-log-relay";

describe("client log relay", () => {
  it("formats structured and error arguments for the terminal", () => {
    expect(
      formatClientLogArguments([
        "request failed",
        { status: 502 },
        new Error("worker unavailable"),
      ]),
    ).toContain('request failed {"status":502} Error: worker unavailable');
  });

  it("handles circular data and bigint values", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatClientLogArguments([circular, 12n])).toBe(
      '{"self":"[Circular]"} 12n',
    );
  });

  it("bounds terminal messages", () => {
    const message = formatClientLogArguments(["x".repeat(20_000)]);
    expect(message.length).toBeLessThan(16_500);
    expect(message.endsWith("… [truncated]")).toBe(true);
  });

  it("keeps a bounded sanitized client buffer outside Tauri", () => {
    clearClientLogs();
    recordClientLog("error", ["request failed", { apiKey: "secret-key" }]);
    const result = readClientLogs({ afterCursor: 0, limit: 10 });
    expect(result.records).toMatchObject([
      {
        system: "client",
        level: "error",
        message: "client.diagnostic",
      },
    ]);
    expect(result.nextCursor).toBe(result.latestCursor);
  });

  it("fans deliberate client events to sanitized console and Logs records", () => {
    clearClientLogs();
    const lines: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => lines.push(values);
    try {
      clientLogger.event("info", "Server connection restored", {
        event: "server.connection.restored",
        subsystem: "connection",
        authorization: "Bearer unsafe-value",
      });
    } finally {
      console.info = originalInfo;
    }
    expect(JSON.stringify(lines)).not.toContain("unsafe-value");
    expect(readClientLogs().records).toMatchObject([
      {
        system: "client",
        level: "info",
        message: "server.connection.restored",
        context: {
          event: "server.connection.restored",
          subsystem: "connection",
        },
      },
    ]);
  });

  it("reduces operational failures to class, code, and status metadata", () => {
    const error = Object.assign(
      new Error("provider response contains private payload text"),
      {
        code: "UPSTREAM_FAILED",
        failureStage: "worker-share-open",
        requestId: "request-one",
        status: 502,
        workerId: "worker-one",
        workerRequestId: "worker-request-one",
      },
    );
    const metadata = operationalErrorMetadata(error);
    expect(metadata).toEqual({
      errorClass: "Error",
      errorCode: "UPSTREAM_FAILED",
      errorStatus: 502,
      failureStage: "worker-share-open",
      requestId: "request-one",
      workerId: "worker-one",
      workerRequestId: "worker-request-one",
    });
    expect(JSON.stringify(metadata)).not.toContain("private payload");

    const rejected = operationalErrorMetadata(
      Object.assign(new Error("private"), {
        failureStage: "/Users/private/project",
        workerId: "worker one /Users/private/project",
      }),
    );
    expect(rejected).not.toHaveProperty("failureStage");
    expect(rejected).not.toHaveProperty("workerId");
  });

  it("captures pre-bootstrap console and fetch failures without URL secrets", async () => {
    const invocations: Array<{
      args: { level: string; message: string; source?: string };
      command: string;
    }> = [];
    const listeners = new Map<string, EventListener>();
    const silentConsole = {
      debug(..._values: unknown[]) {},
      error(..._values: unknown[]) {},
      info(..._values: unknown[]) {},
      log(..._values: unknown[]) {},
      trace(..._values: unknown[]) {},
      warn(..._values: unknown[]) {},
    };
    const window = {
      __TAURI_INTERNALS__: {
        invoke(command: string, args: (typeof invocations)[number]["args"]) {
          invocations.push({ args, command });
          return Promise.resolve();
        },
      },
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
      },
      fetch: async (..._args: unknown[]) => ({ ok: false, status: 503 }),
      location: { href: "http://127.0.0.1:1420/" },
    };
    const context = {
      console: silentConsole,
      Element: class {},
      Error,
      ErrorEvent: class {},
      JSON,
      Promise,
      Request,
      String,
      URL,
      WeakSet,
      window,
    };
    const runRelay = new Function(
      "globalThis",
      "window",
      "console",
      "Element",
      "ErrorEvent",
      "Request",
      "URL",
      "WeakSet",
      "Promise",
      "JSON",
      "String",
      "Error",
      clientLogRelaySource,
    );

    runRelay(
      context,
      window,
      silentConsole,
      context.Element,
      context.ErrorEvent,
      context.Request,
      context.URL,
      context.WeakSet,
      context.Promise,
      context.JSON,
      context.String,
      context.Error,
    );
    await Promise.resolve();
    const connectedInvocationCount = invocations.length;
    context.console.info("[client] deliberate event");
    await Promise.resolve();
    expect(invocations).toHaveLength(connectedInvocationCount);
    context.console.error("client exploded");
    context.console.error("apiKey=sk-abcdefghijk");
    context.console.error(
      "https://user:password@example.test/failure?token=secret",
    );
    context.console.error(
      "https://download.example.test/artifact?signature=private-signature&expires=private-expiry",
    );
    await context.window.fetch(
      "https://user:password@example.test/failure?token=secret#private",
    );
    await Promise.resolve();

    expect(listeners.has("error")).toBe(true);
    expect(listeners.has("securitypolicyviolation")).toBe(true);
    listeners.get("securitypolicyviolation")?.({
      blockedURI:
        "https://reader:open-sesame@example.test/script.js?apiKey=sk-source-secret",
      sourceFile: "",
      violatedDirective: "script-src",
    } as unknown as Event);
    await Promise.resolve();
    expect(invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.objectContaining({
            level: "error",
            message: "client exploded",
          }),
          command: "relay_client_log",
        }),
        {
          args: {
            level: "error",
            message: "Fetch GET returned 503",
            source: "https://example.test/failure",
          },
          command: "relay_client_log",
        },
      ]),
    );
    expect(JSON.stringify(invocations)).not.toContain("sk-abcdefghijk");
    expect(JSON.stringify(invocations)).not.toContain("sk-source-secret");
    expect(JSON.stringify(invocations)).not.toContain("open-sesame");
    expect(JSON.stringify(invocations)).not.toContain("user:password");
    expect(JSON.stringify(invocations)).not.toContain("token=secret");
    expect(JSON.stringify(invocations)).not.toContain("private-signature");
    expect(JSON.stringify(invocations)).not.toContain("private-expiry");
  });
});
