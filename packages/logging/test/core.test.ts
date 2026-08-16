import { describe, expect, it } from "vitest";

import { createServiceLogEmitter } from "../src/core.js";

const start = new Date("2026-08-16T12:00:00.000Z");

describe("service log emitter", () => {
  it("fans the same sanitized record to output and storage", () => {
    const output: unknown[] = [];
    const stored: unknown[] = [];
    const logger = createServiceLogEmitter("worker", {
      now: () => start,
      output: (record) => output.push(record),
      onRecord: (record) => stored.push(record),
    });

    logger.event("warn", "Provider token=secret failed", {
      event: "provider.refresh.failed",
      subsystem: "provider",
      error: new Error("Authorization: Bearer unsafe-value"),
      oauthCode: "private-code",
    });

    expect(output).toEqual(stored);
    expect(output).toEqual([
      {
        timestamp: start.toISOString(),
        system: "worker",
        level: "warn",
        message: "Provider token=[REDACTED] failed",
        context: {
          event: "provider.refresh.failed",
          subsystem: "provider",
          error: {
            name: "Error",
            message: "Authorization: [REDACTED]",
          },
          oauthCode: "[REDACTED]",
        },
      },
    ]);
  });

  it("supports trace and fatal levels", () => {
    const records: Array<{ level: string }> = [];
    const logger = createServiceLogEmitter("server", {
      now: () => start,
      onRecord: (record) => records.push(record),
    });
    logger.trace("transport sample");
    logger.fatal("runtime stopped");
    expect(records.map((record) => record.level)).toEqual(["trace", "fatal"]);
  });

  it("summarizes repeated events instead of flooding sinks", () => {
    let clock = start.getTime();
    const records: Array<{ context?: unknown; message: string }> = [];
    const logger = createServiceLogEmitter("worker", {
      now: () => new Date(clock),
      onRecord: (record) => records.push(record),
    });
    for (let index = 0; index < 4; index += 1) {
      logger.rateLimited(
        "ollama-catalog",
        "warn",
        "Catalog refresh failed",
        { event: "provider.refresh.failed", subsystem: "provider" },
        { summaryEvery: 3, windowMs: 60_000 },
      );
      clock += 1_000;
    }

    expect(records).toHaveLength(2);
    expect(records[0]?.message).toBe("Catalog refresh failed");
    expect(records[1]).toMatchObject({
      message: "Catalog refresh failed (repeated 3 additional times)",
      context: {
        counts: { repeated: 3 },
        reasonCode: "repeated-event",
      },
    });
  });

  it("samples deterministic high-volume diagnostics", () => {
    const messages: string[] = [];
    const logger = createServiceLogEmitter("worker", {
      now: () => start,
      onRecord: (record) => messages.push(record.message),
    });
    for (let index = 0; index < 7; index += 1) {
      logger.sampled("transport", 3, "trace", `sample ${index}`);
    }
    expect(messages).toEqual(["sample 0", "sample 3", "sample 6"]);
  });
});
