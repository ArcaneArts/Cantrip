import { describe, expect, it } from "vitest";

import {
  decodeWorkerRequestEnvelope,
  decodeWorkerServerEnvelope,
  serviceLogReadResultSchema,
  workerLogReadQuerySchema,
  workerLogStreamServerMessageSchema,
} from "../src/index.js";

describe("worker service log protocol", () => {
  it("normalizes bounded client queries", () => {
    expect(
      workerLogReadQuerySchema.parse({
        afterCursor: "42",
        beforeCursor: "84",
        limit: "50",
        minimumLevel: "warn",
      }),
    ).toEqual({
      afterCursor: 42,
      beforeCursor: 84,
      limit: 50,
      minimumLevel: "warn",
    });
    expect(workerLogReadQuerySchema.safeParse({ limit: "501" }).success).toBe(
      false,
    );
  });

  it("decodes a bounded newest-first diagnostics read", () => {
    const decoded = decodeWorkerRequestEnvelope(
      JSON.stringify({
        kind: "request",
        requestId: "request-tail",
        command: {
          type: "diagnostics.logs.read",
          beforeCursor: 9_001,
          limit: 100,
        },
      }),
    );
    expect(decoded).toMatchObject({
      success: true,
      data: {
        command: {
          afterCursor: 0,
          beforeCursor: 9_001,
          limit: 100,
          minimumLevel: "trace",
        },
      },
    });
  });

  it("decodes the diagnostics read command with safe defaults", () => {
    const decoded = decodeWorkerRequestEnvelope(
      JSON.stringify({
        kind: "request",
        requestId: "request-1",
        command: { type: "diagnostics.logs.read" },
      }),
    );
    expect(decoded).toEqual({
      success: true,
      data: {
        kind: "request",
        requestId: "request-1",
        command: {
          type: "diagnostics.logs.read",
          afterCursor: 0,
          limit: 200,
          minimumLevel: "trace",
        },
      },
    });
  });

  it("rejects oversized or malformed worker results", () => {
    expect(
      serviceLogReadResultSchema.safeParse({
        records: [
          {
            cursor: 1,
            timestamp: new Date().toISOString(),
            system: "worker",
            level: "verbose",
            message: "not a valid level",
          },
        ],
        nextCursor: 1,
        oldestCursor: 1,
        latestCursor: 1,
        hasMore: false,
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it("validates leased stream commands and bounded notifications", () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000001";
    expect(
      decodeWorkerRequestEnvelope(
        JSON.stringify({
          kind: "request",
          requestId: "stream-1",
          command: {
            type: "diagnostics.logs.stream.start",
            subscriptionId,
            afterCursor: 9,
            minimumLevel: "info",
            leaseMs: 120_000,
          },
        }),
      ),
    ).toMatchObject({ success: true });
    expect(
      decodeWorkerServerEnvelope(
        JSON.stringify({
          kind: "notification",
          notification: {
            type: "diagnostics.logs.observed",
            subscriptionId,
            records: [],
            nextCursor: 10,
            oldestCursor: 1,
            latestCursor: 10,
            truncated: false,
          },
        }),
      ),
    ).toMatchObject({ success: true });
    expect(
      workerLogStreamServerMessageSchema.safeParse({
        type: "batch",
        records: Array.from({ length: 201 }, (_, index) => ({
          cursor: index + 1,
          timestamp: new Date().toISOString(),
          system: "worker",
          level: "info",
          message: "bounded",
        })),
        nextCursor: 201,
        oldestCursor: 1,
        latestCursor: 201,
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
