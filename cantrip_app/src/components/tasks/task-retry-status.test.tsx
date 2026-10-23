// @vitest-environment jsdom
import type { TaskDetail } from "@cantrip/protocol/tasks";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRetryStatus, taskRetryStatusText } from "./task-retry-status";
import { taskImplementationStatusLabel } from "./task-implementation-dashboard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const task = {
  state: "failed",
  automaticRetry: {
    status: "scheduled",
    failureKind: "timeout",
    recentAttempts: 0,
    nextAttemptAt: "2026-10-22T00:00:05.000Z",
  },
} as TaskDetail;
afterEach(() => vi.useRealTimers());
describe("Task retry feedback", () => {
  it("shows a ticking countdown without scheduling execution in the browser", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-22T00:00:00.000Z");
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<TaskRetryStatus task={task} />);
    });
    expect(renderer.toJSON()).toBe("Timeout. Retrying in 5s…");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(renderer.toJSON()).toBe("Timeout. Retrying in 4s…");
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(renderer.toJSON()).toBe("Timeout. Waiting to retry…");
    const reset = {
      ...task,
      automaticRetry: {
        ...task.automaticRetry!,
        nextAttemptAt: new Date(Date.now() + 5000).toISOString(),
      },
    };
    await act(async () => {
      renderer.update(<TaskRetryStatus task={reset} />);
    });
    expect(renderer.toJSON()).toBe("Timeout. Retrying in 5s…");
    await act(async () => {
      renderer.unmount();
    });
  });
  it("shows a manual reset action after the rolling latch trips", () => {
    const latched = {
      ...task,
      automaticRetry: { ...task.automaticRetry!, status: "latched" as const },
    };
    expect(taskRetryStatusText(latched, false, Date.now())).toContain(
      "Retry to start a new window",
    );
    expect(taskRetryStatusText(latched, true)).toBe(
      "Automatic retry is paused.",
    );
  });
  it("calls a timeout a timeout, not a human blocker, and keeps completed Tasks terminal", () => {
    expect(taskImplementationStatusLabel(task, null)).toBe("Timeout");
    expect(
      taskImplementationStatusLabel({ ...task, state: "complete" }, null),
    ).toBe("Complete");
    expect(taskRetryStatusText({ ...task, state: "complete" })).toBeNull();
  });
  it("does not promise automatic retries for configuration and budget stops", () => {
    expect(
      taskRetryStatusText({
        ...task,
        automaticRetry: {
          ...task.automaticRetry!,
          status: "manual",
          failureKind: "budget-limit",
        },
      }),
    ).toBe("Budget reached. Review the issue, then Retry.");
  });
});
