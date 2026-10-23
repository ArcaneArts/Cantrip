import { describe, expect, it } from "vitest";
import {
  taskAutomaticRetrySchema,
  taskFailureKindForError,
} from "../src/task-retry.js";

const scheduled = {
  status: "scheduled",
  failureKind: "timeout",
  nextAttemptAt: "2026-10-22T00:00:05.000Z",
  recentAttempts: 0,
};
describe("Task retry operational contract", () => {
  it("accepts a bounded scheduled status", () => {
    expect(taskAutomaticRetrySchema.parse(scheduled)).toEqual(scheduled);
  });
  it("requires a deadline only when scheduled", () => {
    expect(
      taskAutomaticRetrySchema.safeParse({ ...scheduled, nextAttemptAt: null })
        .success,
    ).toBe(false);
    expect(
      taskAutomaticRetrySchema.safeParse({ ...scheduled, status: "latched" })
        .success,
    ).toBe(false);
    expect(
      taskAutomaticRetrySchema.safeParse({
        ...scheduled,
        status: "latched",
        nextAttemptAt: null,
        recentAttempts: 5,
      }).success,
    ).toBe(true);
  });
  it("rejects unbounded counts, arbitrary categories and plaintext diagnostics", () => {
    for (const extra of [
      { recentAttempts: 6 },
      { failureKind: "private error text" },
      { errorMessage: "private error text" },
    ])
      expect(
        taskAutomaticRetrySchema.safeParse({ ...scheduled, ...extra }).success,
      ).toBe(false);
  });
  it("carries a stable category through a protected worker failure", () => {
    expect(
      taskFailureKindForError(
        new Error("Encrypted Task operation failed: task-capacity."),
      ),
    ).toBe("capacity");
    expect(taskFailureKindForError("task-goal-start-configuration")).toBe(
      "configuration",
    );
  });
});
