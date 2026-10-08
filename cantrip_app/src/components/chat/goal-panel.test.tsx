import type { ThreadGoal } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoalPanel } from "./goal-panel";

const goal: ThreadGoal = {
  threadId: "native-thread",
  objective: "Finish implementation",
  status: "active",
  tokenBudget: null,
  tokensUsed: 226675,
  timeUsedSeconds: 1733,
  createdAt: 1,
  updatedAt: 2,
};

describe("Goal automation pause", () => {
  it("offers explicit recovery for an existing failed turn without claiming its saved Goal is running", () => {
    const markup = renderToStaticMarkup(
      <GoalPanel
        goal={goal}
        executionFailed
        pending={false}
        onClear={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(markup).toContain("Failed");
    expect(markup).toContain("Resume goal");
    expect(markup).not.toContain("Running");
  });

  it("shows Resume instead of a misleading Running badge when chat automation is paused", () => {
    const markup = renderToStaticMarkup(
      <GoalPanel
        goal={goal}
        automationPaused
        pending={false}
        onClear={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(markup).toContain("Paused");
    expect(markup).toContain("Resume goal");
    expect(markup).not.toContain("Running");
    expect(markup).not.toContain("Pause goal");
  });

  it("keeps normal active goals running and completed goals hidden", () => {
    const props = { pending: false, onClear: vi.fn(), onUpdate: vi.fn() };
    expect(
      renderToStaticMarkup(<GoalPanel {...props} goal={goal} />),
    ).toContain("Running");
    expect(
      renderToStaticMarkup(
        <GoalPanel
          {...props}
          automationPaused
          goal={{ ...goal, status: "complete" }}
        />,
      ),
    ).toBe("");
  });
});
