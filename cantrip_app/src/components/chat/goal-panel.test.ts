import { describe, expect, it } from "vitest";

import { formatGoalElapsed } from "./goal-panel";

describe("goal panel", () => {
  it("formats short and long elapsed times", () => {
    expect(formatGoalElapsed(8)).toBe("8s");
    expect(formatGoalElapsed(125)).toBe("2m 5s");
    expect(formatGoalElapsed(7_500)).toBe("2h 5m");
  });
});
