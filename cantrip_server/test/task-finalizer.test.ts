import { describe, expect, it } from "vitest";

import {
  buildTaskGoalObjective,
  normalizedTaskFinalizationMessage,
} from "../src/tasks/planner.js";

const result = {
  finalPlanMarkdown:
    "# Final plan\n\n- Deliver every acceptance criterion.\n- Validate the finished result.",
  goalPrompt: "Implement all milestones and finish the complete plan.",
};

describe("Task finalization", () => {
  it("builds a policy-aware whole-plan Goal objective without hardcoded policy bodies", () => {
    const objective = buildTaskGoalObjective(result);
    expect(objective).toContain("# Cantrip Task implementation objective");
    expect(objective).toContain("cantrip policy list");
    expect(objective).toContain("cantrip policy read <policy-key>");
    expect(objective).toContain(result.goalPrompt);
    expect(objective).toContain(result.finalPlanMarkdown);
    expect(objective).toContain("Do not stop after only the first milestone");
    expect(objective).not.toContain("MANUAL_CHANGE_PROTOCOL.md");
  });

  it("normalizes the finalizer artifact for the visible Task transcript", () => {
    const message = normalizedTaskFinalizationMessage(result);
    expect(message).toContain(result.finalPlanMarkdown);
    expect(message).toContain("implementation Goal has been prepared");
    expect(message).not.toContain(result.goalPrompt);
  });

  it("rejects a combined objective that cannot fit the Goal protocol", () => {
    expect(() =>
      buildTaskGoalObjective({
        finalPlanMarkdown: "p".repeat(99_900),
        goalPrompt: "g".repeat(99_900),
      }),
    ).toThrow("combined Task Goal objective exceeds");
  });
});
