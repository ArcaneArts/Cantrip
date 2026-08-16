import { describe, expect, it } from "vitest";

import {
  createServiceLogger,
  createPinoServiceLogStream,
  formatDuration,
  formatHttpLog,
  formatServiceLog,
} from "../src/index.js";

const timestamp = new Date(2026, 7, 13, 22, 15, 30);

describe("service logging", () => {
  it("formats HTTP requests without structured logger noise", () => {
    expect(
      formatHttpLog({
        colors: false,
        durationMs: 1.99,
        method: "GET",
        path: "/requested/path",
        statusCode: 200,
        system: "server",
        timestamp,
      }),
    ).toBe("[server] 22:15: GET /requested/path -> 200 OK (1ms)");
  });

  it("uses microseconds for sub-half-millisecond requests", () => {
    expect(formatDuration(0.499)).toBe("499µs");
    expect(formatDuration(0)).toBe("1µs");
    expect(formatDuration(0.5)).toBe("1ms");
  });

  it("renders event context as readable fields instead of JSON", () => {
    const formatted = formatServiceLog({
      colors: false,
      context: { hostname: "hidden", database: "postgres", pid: 42 },
      message: "Cantrip Server is ready",
      system: "server",
      timestamp,
    });
    expect(formatted).toBe(
      "[server] 22:15: Cantrip Server is ready · database=postgres",
    );
    expect(formatted).not.toContain("hostname");
    expect(formatted).not.toContain("pid");
  });

  it("joins Fastify request start and completion records", () => {
    const lines: string[] = [];
    const stream = createPinoServiceLogStream("server", {
      colors: false,
      output: (line) => lines.push(line),
    });
    stream.write(
      `${JSON.stringify({
        level: 30,
        time: timestamp.getTime(),
        pid: 73747,
        hostname: "MaxBook-Pro.local",
        reqId: "request-id",
        req: { method: "POST", url: "/api/workers" },
        msg: "incoming request",
      })}\n`,
    );
    stream.write(
      `${JSON.stringify({
        level: 30,
        time: timestamp.getTime(),
        pid: 73747,
        hostname: "MaxBook-Pro.local",
        reqId: "request-id",
        res: { statusCode: 201 },
        responseTime: 0.25,
        msg: "request completed",
      })}\n`,
    );

    expect(lines).toEqual([
      "[server] 22:15: POST /api/workers -> 201 Created (250µs)",
    ]);
  });

  it("colors request fields by role and outcome", () => {
    const formatted = formatHttpLog({
      colors: true,
      durationMs: 20,
      method: "DELETE",
      path: "/api/workers/one",
      statusCode: 503,
      system: "worker",
      timestamp,
    });
    expect(formatted).toContain("\u001b[35m[worker]\u001b[0m");
    expect(formatted).toContain("\u001b[34mDELETE\u001b[0m");
    expect(formatted).toContain("\u001b[31m503 Service Unavailable\u001b[0m");
  });

  it("emits the same sanitized event to console and structured sinks", () => {
    const lines: string[] = [];
    const records: unknown[] = [];
    const logger = createServiceLogger("worker", {
      colors: false,
      now: () => timestamp,
      output: (line) => lines.push(line),
      onRecord: (record) => records.push(record),
    });
    logger.warn("Credential rejected", {
      apiKey: "sk-abcdefghijk",
      endpoint: "https://example.com?token=secret",
    });

    expect(lines).toEqual([
      "[worker] 22:15: WARN Credential rejected · apiKey=[REDACTED] endpoint=https://example.com/?token=%5BREDACTED%5D",
    ]);
    expect(records).toEqual([
      {
        timestamp: timestamp.toISOString(),
        system: "worker",
        level: "warn",
        message: "Credential rejected",
        context: {
          apiKey: "[REDACTED]",
          endpoint: "https://example.com/?token=%5BREDACTED%5D",
        },
      },
    ]);
  });

  it("removes query strings from Fastify access logs and records", () => {
    const lines: string[] = [];
    const records: Array<{ context?: unknown; message: string }> = [];
    const stream = createPinoServiceLogStream("server", {
      colors: false,
      output: (line) => lines.push(line),
      onRecord: (record) => records.push(record),
    });
    stream.write(
      `${JSON.stringify({
        level: 30,
        time: timestamp.getTime(),
        reqId: "safe-request-id",
        req: {
          method: "GET",
          url: "/api/providers?access_token=unsafe#private",
        },
        msg: "incoming request",
      })}\n`,
    );
    stream.write(
      `${JSON.stringify({
        level: 30,
        time: timestamp.getTime(),
        reqId: "safe-request-id",
        res: { statusCode: 200 },
        responseTime: 2,
        msg: "request completed",
      })}\n`,
    );
    expect(lines).toEqual([
      "[server] 22:15: GET /api/providers -> 200 OK (2ms)",
    ]);
    expect(JSON.stringify(records)).not.toContain("unsafe");
    expect(records[0]).toMatchObject({
      message: "GET /api/providers -> 200 OK (2ms)",
      context: {
        event: "http.request.completed",
        subsystem: "http",
        requestId: "safe-request-id",
      },
    });
  });
});
