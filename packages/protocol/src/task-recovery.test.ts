import { describe, expect, it } from "vitest";
import { taskRecoveryStartSchema } from "./tasks.js";

describe("Task session recovery contract", () => {
  it("accepts a no-prompt recovery control", () => {
    expect(taskRecoveryStartSchema.parse({})).toEqual({});
  });
  it.each([
    { prompt: "replace the task" },
    { threadId: "other" },
    { worktreeId: "other" },
    { ownerId: "other" },
  ])("rejects user-supplied session identity or prose: %o", (value) => {
    expect(taskRecoveryStartSchema.safeParse(value).success).toBe(false);
  });
});
