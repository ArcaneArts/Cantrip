import { describe, expect, it } from "vitest";

import {
  TaskStateTransitionError,
  assertTaskStateTransition,
  canTransitionTaskState,
  taskOperationState,
  taskOperationStableState,
  taskRetryState,
  validateTaskOperationStart,
} from "../src/tasks/state.js";

describe("Task state transitions", () => {
  it("allows only declared lifecycle transitions", () => {
    expect(canTransitionTaskState("draft", "planning")).toBe(true);
    expect(canTransitionTaskState("planning", "review")).toBe(true);
    expect(canTransitionTaskState("review", "finalizing")).toBe(true);
    expect(canTransitionTaskState("finalizing", "implementing")).toBe(true);
    expect(canTransitionTaskState("implementing", "paused")).toBe(true);
    expect(canTransitionTaskState("paused", "implementing")).toBe(true);
    expect(canTransitionTaskState("blocked", "complete")).toBe(true);
    expect(canTransitionTaskState("complete", "implementing")).toBe(false);
    expect(() => assertTaskStateTransition("draft", "complete")).toThrow(
      TaskStateTransitionError,
    );
  });

  it("maps operation kinds to active and stable states", () => {
    expect(taskOperationState("initial-plan")).toBe("planning");
    expect(taskOperationState("continue-plan")).toBe("planning");
    expect(taskOperationState("finalize")).toBe("finalizing");
    expect(taskOperationStableState("initial-plan")).toBe("draft");
    expect(taskOperationStableState("continue-plan")).toBe("review");
    expect(taskOperationStableState("finalize")).toBe("review");
  });

  it("only retries the failed operation from its recorded stable state", () => {
    expect(taskRetryState("draft", "initial-plan")).toBe("planning");
    expect(taskRetryState("review", "continue-plan")).toBe("planning");
    expect(taskRetryState("review", "finalize")).toBe("finalizing");
    expect(() => taskRetryState("draft", "finalize")).toThrow(
      TaskStateTransitionError,
    );
  });

  it("validates fresh and retry operation starts", () => {
    expect(validateTaskOperationStart("draft", null, "initial-plan")).toEqual({
      nextState: "planning",
      stableState: "draft",
    });
    expect(validateTaskOperationStart("review", null, "continue-plan")).toEqual(
      { nextState: "planning", stableState: "review" },
    );
    expect(validateTaskOperationStart("failed", "review", "finalize")).toEqual({
      nextState: "finalizing",
      stableState: "review",
    });
    expect(() =>
      validateTaskOperationStart("review", null, "initial-plan"),
    ).toThrow(TaskStateTransitionError);
  });
});
