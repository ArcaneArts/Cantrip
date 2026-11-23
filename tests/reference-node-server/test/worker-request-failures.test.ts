import { describe, expect, it } from "vitest";

import { workerFailureResponse } from "../src/http/worker-request-failures.js";
import { RelayLimitError } from "../src/security/abuse-limits.js";
import { WorkerUnavailableError } from "../src/workers/bridge.js";

describe("worker request failure responses", () => {
  it.each([
    {
      error: new Error("Relay failed."),
      expectedStatus: 502,
      fallbackStatus: 502 as const,
    },
    {
      error: new Error("Operation conflicted."),
      expectedStatus: 409,
      fallbackStatus: 409 as const,
    },
    {
      error: new RelayLimitError("Relay limit reached."),
      expectedStatus: 429,
      fallbackStatus: 502 as const,
    },
    {
      error: new RelayLimitError("Relay limit reached."),
      expectedStatus: 429,
      fallbackStatus: 409 as const,
    },
    {
      error: new WorkerUnavailableError("Worker is offline."),
      expectedStatus: 503,
      fallbackStatus: 502 as const,
    },
    {
      error: new WorkerUnavailableError("Worker is offline."),
      expectedStatus: 503,
      fallbackStatus: 409 as const,
    },
  ])(
    "maps $error.name with a $fallbackStatus fallback to $expectedStatus",
    ({ error, expectedStatus, fallbackStatus }) => {
      expect(workerFailureResponse(error, fallbackStatus)).toEqual({
        body: { error: error.message },
        statusCode: expectedStatus,
      });
    },
  );

  it("normalizes non-Error values and preserves contextual messages", () => {
    expect(workerFailureResponse("relay failed", 502)).toEqual({
      body: { error: "relay failed" },
      statusCode: 502,
    });
    expect(
      workerFailureResponse(
        new WorkerUnavailableError("Worker is offline."),
        409,
        "The runtime no longer accepts this interaction: Worker is offline.",
      ),
    ).toEqual({
      body: {
        error:
          "The runtime no longer accepts this interaction: Worker is offline.",
      },
      statusCode: 503,
    });
  });

  it("preserves structured worktree mutation outcomes", () => {
    const failure = {
      code: "worktree-create-rolled-back" as const,
      error: "Creation failed and was rolled back.",
      mutation: {
        outcome: "rolledBack" as const,
        retryable: true,
        target: {
          kind: "worktree" as const,
          projectId: "project-1",
          worktreeId: "worktree-1",
        },
      },
    };
    expect(workerFailureResponse({ failure }, 409)).toEqual({
      body: failure,
      statusCode: 409,
    });
  });
});
