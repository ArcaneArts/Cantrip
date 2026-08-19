import { describe, expect, it } from "vitest";

import {
  buildTaskGoalObjective,
  normalizedTaskFinalizationMessage,
  parseTaskFinalizerResult,
  parseTaskPlannerResult,
} from "../src/tasks/planner.js";

const result = {
  finalPlanMarkdown:
    "# Final plan\n\n- Deliver every acceptance criterion.\n- Validate the finished result.",
  goalPrompt: "Implement all milestones and finish the complete plan.",
};

describe("Task planner results", () => {
  it("preserves a non-empty structured plan", () => {
    expect(
      parseTaskPlannerResult(
        { planMarkdown: "# Planned result", questions: [] },
        "# User brief",
      ),
    ).toEqual({ planMarkdown: "# Planned result", questions: [] });
  });

  it("uses the saved planning input when structured plan text is empty", () => {
    expect(
      parseTaskPlannerResult(
        { planMarkdown: "  \n", questions: [] },
        "# User brief\n\nPreserve this task direction.",
      ),
    ).toEqual({
      planMarkdown: "# User brief\n\nPreserve this task direction.",
      questions: [],
    });
  });

  it("still rejects malformed structured planner output", () => {
    expect(() =>
      parseTaskPlannerResult({ questions: [] }, "# User brief"),
    ).toThrow();
  });
});

describe("Task finalization", () => {
  it("preserves a non-empty structured finalization result", () => {
    expect(parseTaskFinalizerResult(result, "# Reviewed plan")).toEqual(result);
  });

  it("uses the reviewed plan and a safe Goal direction when finalization text is empty", () => {
    expect(
      parseTaskFinalizerResult(
        { finalPlanMarkdown: "\n", goalPrompt: "  " },
        "# Reviewed plan\n\nImplement the saved Task.",
      ),
    ).toEqual({
      finalPlanMarkdown: "# Reviewed plan\n\nImplement the saved Task.",
      goalPrompt:
        "Implement the complete final plan, validate the finished result, and continue until every acceptance criterion is satisfied.",
    });
  });

  it("still rejects malformed structured finalization output", () => {
    expect(() =>
      parseTaskFinalizerResult(
        { finalPlanMarkdown: "", goalPrompt: null },
        "# Reviewed plan",
      ),
    ).toThrow();
  });

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
