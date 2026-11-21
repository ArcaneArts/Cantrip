import { describe, expect, it } from "vitest";

import {
  captureWorkerDiagnostic,
  readWorkerLogs,
  subscribeWorkerLogs,
  workerLogError,
  workerLogErrorIdentity,
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
          message: "worker.diagnostic",
          context: { attempt: 2 },
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
          message: "worker.diagnostic",
          context: { subsystem: "codex" },
        },
      ],
      hasMore: false,
      truncated: false,
    });
  });

  it("notifies active readers with the sanitized stored record", () => {
    const records: unknown[] = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    captureWorkerDiagnostic("info", "token=ghp_abcdefghijk", {
      event: "worker.test",
    });
    unsubscribe();
    captureWorkerDiagnostic("info", "after unsubscribe");

    expect(records).toEqual([
      expect.objectContaining({
        cursor: expect.any(Number),
        message: "worker.test",
        context: { event: "worker.test" },
      }),
    ]);
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

  it("reduces transport errors to class and code without sensitive messages", () => {
    const error = Object.assign(
      new Error(
        "token=transport-secret file:///worker/private/project.code-workspace ciphertext-fragment-123",
      ),
      { code: "ECONNREFUSED" },
    );

    const identity = workerLogErrorIdentity(error);

    expect(identity).toEqual({
      errorClass: "Error",
      errorCode: "ECONNREFUSED",
    });
    expect(JSON.stringify(identity)).not.toContain("transport-secret");
    expect(JSON.stringify(identity)).not.toContain("project.code-workspace");
    expect(JSON.stringify(identity)).not.toContain("ciphertext-fragment-123");
  });

  it("rejects hostile error identity fields containing protected material", () => {
    const pathSentinel = "/worker/private/project.code-workspace";
    const protectedSentinel = "ciphertext-fragment-123";
    const secretSentinel = "transport-secret";
    const error = Object.assign(new Error("safe message"), {
      name: `TypeError${pathSentinel}${protectedSentinel}${secretSentinel}`,
      code: `E_TRANSPORT_${pathSentinel}_${protectedSentinel}_${secretSentinel}`,
    });

    const identity = workerLogErrorIdentity(error);
    const serialized = JSON.stringify(identity);

    expect(identity).toEqual({ errorClass: "Error" });
    expect(serialized).not.toContain(pathSentinel);
    expect(serialized).not.toContain(protectedSentinel);
    expect(serialized).not.toContain(secretSentinel);
  });

  it("rejects purely alphanumeric hostile error identity fields", () => {
    const sentinel = "TransportSecretCiphertextFragment123";
    const error = Object.assign(new Error("safe message"), {
      name: sentinel,
      code: sentinel.toUpperCase(),
    });

    const identity = workerLogErrorIdentity(error);
    const serialized = JSON.stringify(identity);

    expect(identity).toEqual({ errorClass: "Error" });
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(sentinel.toUpperCase());
  });
});
