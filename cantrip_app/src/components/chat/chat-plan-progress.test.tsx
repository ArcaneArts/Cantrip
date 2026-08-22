import type { PlanStep } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChatPlanProgress,
  PlanProgressDetails,
  summarizePlanProgress,
} from "./chat-plan-progress";

describe("summarizePlanProgress", () => {
  it("uses the active step for the compact step count", () => {
    const steps: PlanStep[] = [
      { step: "Inspect the project", status: "completed" },
      { step: "Build the feature", status: "inProgress" },
      { step: "Verify the result", status: "pending" },
    ];

    expect(summarizePlanProgress(steps)).toEqual({
      completedCount: 1,
      currentStepNumber: 2,
      isComplete: false,
      total: 3,
    });
  });

  it("falls forward to the next pending step and finishes at the total", () => {
    expect(
      summarizePlanProgress([
        { step: "One", status: "completed" },
        { step: "Two", status: "pending" },
      ]),
    ).toMatchObject({ currentStepNumber: 2, isComplete: false });

    expect(
      summarizePlanProgress([
        { step: "One", status: "completed" },
        { step: "Two", status: "completed" },
      ]),
    ).toEqual({
      completedCount: 2,
      currentStepNumber: 2,
      isComplete: true,
      total: 2,
    });
  });

  it("returns nothing when Codex has not published any steps", () => {
    expect(summarizePlanProgress([])).toBeNull();
  });
});

describe("ChatPlanProgress", () => {
  it("renders the compact progress control while keeping details collapsed", () => {
    const markup = renderToStaticMarkup(
      <ChatPlanProgress
        explanation="Ship the composer progress UI."
        loading
        steps={[
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ]}
      />,
    );

    expect(markup).toContain("Step 2 / 3");
    expect(markup).toContain("1 complete");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain("Ship the composer progress UI.");
  });

  it("stops animating an in-progress step after the model stops", () => {
    const markup = renderToStaticMarkup(
      <ChatPlanProgress
        explanation={null}
        loading={false}
        steps={[
          { step: "Interrupted work", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ]}
      />,
    );

    expect(markup).toContain("Step 1 / 2");
    expect(markup).not.toContain("animate-spin");
  });

  it("shows the explanation and every status in the expanded details", () => {
    const markup = renderToStaticMarkup(
      <PlanProgressDetails
        explanation="Ship the composer progress UI."
        loading
        summary={{
          completedCount: 1,
          currentStepNumber: 2,
          isComplete: false,
          total: 3,
        }}
        steps={[
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ]}
      />,
    );

    expect(markup).toContain("Ship the composer progress UI.");
    expect(markup).toContain("Inspect");
    expect(markup).toContain("Implement");
    expect(markup).toContain("Verify");
    expect(markup).toContain('aria-current="step"');
  });
});
