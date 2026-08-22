import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatGoalElapsed, GoalPanel } from "./goal-panel";

describe("goal panel", () => {
  it("formats short and long elapsed times", () => {
    expect(formatGoalElapsed(8)).toBe("8s");
    expect(formatGoalElapsed(125)).toBe("2m 5s");
    expect(formatGoalElapsed(7_500)).toBe("2h 5m");
  });

  it("removes a completed goal from the chat", () => {
    expect(
      GoalPanel({
        error: null,
        goal: {
          threadId: "thread-1",
          objective: "Finish the work",
          status: "complete",
          tokenBudget: null,
          tokensUsed: 123,
          timeUsedSeconds: 45,
          createdAt: 1,
          updatedAt: 2,
        },
        onClear: () => undefined,
        onUpdate: () => undefined,
        pending: false,
      }),
    ).toBeNull();
  });

  it("renders active goals on an opaque surface", () => {
    const markup = renderToStaticMarkup(
      GoalPanel({
        error: null,
        goal: {
          threadId: "thread-1",
          objective: "Finish the work",
          status: "active",
          tokenBudget: null,
          tokensUsed: 123,
          timeUsedSeconds: 45,
          createdAt: 1,
          updatedAt: 2,
        },
        onClear: () => undefined,
        onUpdate: () => undefined,
        pending: false,
      }),
    );

    expect(markup).toContain('data-slot="goal-panel"');
    expect(markup).toContain("bg-[var(--popover-solid)]");
  });
});
