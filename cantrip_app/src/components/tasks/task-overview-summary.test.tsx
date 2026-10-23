// @vitest-environment jsdom
import type {
  ChatSummary,
  TaskDetail,
  TaskGoalSnapshot,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskOverviewSummary as Summary } from "./task-overview-summary";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function TaskOverviewSummary(props: ComponentProps<typeof Summary>) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <Summary {...props} />
    </QueryClientProvider>
  );
}
const chat = { status: "running", automationPaused: false } as ChatSummary;
const task = {
  createdAt: "2026-10-22T10:00:00Z",
  implementationStartedAt: "2026-10-22T10:01:00Z",
  updatedAt: "2026-10-22T10:02:30Z",
  completedAt: null,
} as TaskDetail;
const goal = {
  status: "active",
  timeUsedSeconds: 90,
  tokensUsed: 12_000,
  tokenBudget: 24_000,
} as TaskGoalSnapshot;

describe("Task overview summary", () => {
  afterEach(() => vi.useRealTimers());

  it("shows goal usage and honest lower bounds while older history is unloaded", () => {
    const markup = renderToStaticMarkup(
      <TaskOverviewSummary
        chat={chat}
        task={task}
        goal={goal}
        messages={[]}
        visible
        historyIncomplete
      />,
    );
    expect(markup).toContain("1m 30s");
    expect(markup).toContain("Turns");
    expect(markup).toContain("Files changed");
    expect(markup).toContain("0+");
    expect(markup).toContain("12,000 tokens / 24,000");
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('data-slot="trajectory-activity-bar"');
    expect(markup).not.toContain("Filters");
  });

  it("ticks the running goal timer and stops ticking while paused", async () => {
    vi.useFakeTimers();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TaskOverviewSummary
          chat={chat}
          task={task}
          goal={goal}
          messages={[]}
          visible
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const elapsed = () =>
      renderer.root.findAllByType("dd")[0]!.children.join("");
    expect(elapsed()).toBe("1m 35s");
    await act(async () =>
      renderer.update(
        <TaskOverviewSummary
          chat={chat}
          task={task}
          goal={goal}
          messages={[]}
          visible={false}
        />,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () =>
      renderer.update(
        <TaskOverviewSummary
          chat={chat}
          task={task}
          goal={goal}
          messages={[]}
          visible
        />,
      ),
    );
    expect(elapsed()).toBe("1m 45s");
    await act(async () =>
      renderer.update(
        <TaskOverviewSummary
          chat={{ ...chat, automationPaused: true }}
          task={task}
          goal={{ ...goal, timeUsedSeconds: 105 }}
          messages={[]}
          visible
        />,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(elapsed()).toBe("1m 45s");
    await act(async () => renderer.unmount());
  });

  it("keeps completed direct tasks fixed at their completion time", () => {
    const markup = renderToStaticMarkup(
      <TaskOverviewSummary
        chat={{ ...chat, status: "idle" }}
        task={{ ...task, completedAt: "2026-10-22T10:03:00Z" }}
        goal={null}
        messages={[]}
        visible
      />,
    );
    expect(markup).toContain("2m 0s");
  });
});
