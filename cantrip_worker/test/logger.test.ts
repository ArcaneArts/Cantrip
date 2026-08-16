import { describe, expect, it } from "vitest";

import {
  captureWorkerDiagnostic,
  readWorkerLogs,
  workerLogError,
  workerLogger,
} from "../src/logger.js";

describe("worker service log capture", () => {
  it("captures sanitized service records for cursor reads", () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;
    workerLogger.warn("Provider connection failed", {
      apiKey: "sk-abcdefghijk",
      attempt: 2,
    });
    expect(
      readWorkerLogs({ afterCursor, limit: 200, minimumLevel: "trace" }),
    ).toMatchObject({
      records: [
        {
          cursor: expect.any(Number),
          timestamp: expect.any(String),
          system: "worker",
          level: "warn",
          message: "Provider connection failed",
          context: { apiKey: "[REDACTED]", attempt: 2 },
        },
      ],
      hasMore: false,
      truncated: false,
    });
  });

  it("captures already-emitted subprocess diagnostics without a capability gap", () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;

    captureWorkerDiagnostic(
      "debug",
      "[codex] transport failed with token=ghp_abcdefghijk",
      { subsystem: "codex" },
    );

    expect(
      readWorkerLogs({ afterCursor, limit: 200, minimumLevel: "trace" }),
    ).toMatchObject({
      records: [
        {
          cursor: expect.any(Number),
          timestamp: expect.any(String),
          system: "worker",
          level: "debug",
          message: "[codex] transport failed with token=[REDACTED]",
          context: { subsystem: "codex" },
        },
      ],
      hasMore: false,
      truncated: false,
    });
  });

  it("normalizes operational errors without stacks, causes, or arbitrary fields", () => {
    const cause = new Error("inner token=ghp_abcdefghijk");
    const error = Object.assign(new Error("outer api_key=sk-abcdefghijk"), {
      cause,
      responseBody: "provider payload",
      code: "E_PROVIDER",
    });

    expect(workerLogError(error)).toEqual({
      name: "Error",
      message: "outer api_key=[REDACTED]",
      code: "E_PROVIDER",
    });
  });
});
