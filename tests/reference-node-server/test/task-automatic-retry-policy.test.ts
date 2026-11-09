import { describe, expect, it } from "vitest";
import {
  classifyTaskFailure,
  scheduleTaskRetry,
  taskRetrySummary,
  type TaskRetryRecord,
} from "../src/tasks/automatic-retry.js";

describe("automatic Task retry policy", () => {
  it("distinguishes an offline model worker from configuration that needs user help", () => {
    expect(
      classifyTaskFailure({
        name: "ModelConfigurationResolutionError",
        failure: { code: "worker-offline", retryable: true },
      }),
    ).toBe("connection");
    expect(
      classifyTaskFailure({
        name: "ModelConfigurationResolutionError",
        failure: { code: "root-model-unavailable", retryable: false },
      }),
    ).toBe("configuration");
  });
  it("schedules five seconds after an actual failure and repeated observations do not postpone it", () => {
    const first = scheduleTaskRetry(null, "failure-1", "timeout", 1000);
    expect(first.dueAt).toBe(6000);
    expect(scheduleTaskRetry(first, "failure-1", "timeout", 5999)).toBe(first);
  });
  it("latches after five retry attempts in a rolling minute, even after that minute passes", () => {
    const record: TaskRetryRecord = {
      status: "retrying",
      failureKind: "runtime",
      failureKey: "before",
      dueAt: null,
      attempts: [0, 5000, 10000, 15000, 20000],
      claim: { id: "attempt-5", expiresAt: 999999 },
    };
    const latched = scheduleTaskRetry(record, "failed-again", "runtime", 25000);
    expect(latched).toMatchObject({ status: "latched", dueAt: null });
    expect(scheduleTaskRetry(latched, "later", "runtime", 120000).status).toBe(
      "latched",
    );
    expect(
      scheduleTaskRetry(null, "explicit-retry-reset", "runtime", 120000),
    ).toMatchObject({ status: "scheduled", attempts: [], dueAt: 125000 });
  });
  it("ages out attempts at exactly sixty seconds; spread-out failures do not hit a lifetime limit", () => {
    let record: TaskRetryRecord | null = null;
    for (let i = 0; i < 15; i++) {
      record = scheduleTaskRetry(record, `failure-${i}`, "capacity", i * 30000);
      expect(record.status).toBe("scheduled");
      record = {
        ...record,
        status: "idle",
        attempts: [...record.attempts, i * 30000],
      };
    }
    const next = scheduleTaskRetry(
      { ...record!, attempts: [0, 10000, 20000, 30000, 40000] },
      "boundary",
      "timeout",
      60000,
    );
    expect(next.status).toBe("scheduled");
    expect(next.attempts).toEqual([10000, 20000, 30000, 40000]);
  });
  it.each([
    "needs-input",
    "configuration",
    "usage-limit",
    "budget-limit",
  ] as const)("never automatically retries %s", (kind) => {
    expect(scheduleTaskRetry(null, "needs-help", kind, 1000)).toMatchObject({
      status: "manual",
      dueAt: null,
    });
  });
  it.each([
    ["The request timed out", "timeout"],
    ["serverOverloaded", "capacity"],
    ["HTTP 429", "rate-limit"],
    ["worker disconnected", "connection"],
    ["goal-blocked", "needs-input"],
    ["goal-budget-limited", "budget-limit"],
    ["goal-usage-limited", "usage-limit"],
    ["invalid API key", "configuration"],
    ["unknown exception", "runtime"],
    ["task-goal-start-capacity", "capacity"],
    ["task-goal-start-configuration", "configuration"],
  ])("classifies %s without exposing provider text", (message, expected) => {
    expect(classifyTaskFailure(new Error(message))).toBe(expected);
  });
  it("exposes only bounded operational status, not failure identity or claim data", () => {
    const record = scheduleTaskRetry(
      null,
      "private-error-sentinel",
      "timeout",
      0,
    );
    expect(taskRetrySummary(record, 0)).toEqual({
      status: "scheduled",
      failureKind: "timeout",
      nextAttemptAt: "1970-01-01T00:00:05.000Z",
      recentAttempts: 0,
    });
    expect(JSON.stringify(taskRetrySummary(record))).not.toContain("sentinel");
  });
});
