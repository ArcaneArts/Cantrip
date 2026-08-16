import { describe, expect, it } from "vitest";

import {
  decodeWorkerRequestEnvelope,
  serviceLogReadResultSchema,
  workerLogReadQuerySchema,
} from "../src/index.js";

describe("worker service log protocol", () => {
  it("normalizes bounded client queries", () => {
    expect(
      workerLogReadQuerySchema.parse({
        afterCursor: "42",
        limit: "50",
        minimumLevel: "warn",
      }),
    ).toEqual({ afterCursor: 42, limit: 50, minimumLevel: "warn" });
    expect(workerLogReadQuerySchema.safeParse({ limit: "501" }).success).toBe(
      false,
    );
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
});
