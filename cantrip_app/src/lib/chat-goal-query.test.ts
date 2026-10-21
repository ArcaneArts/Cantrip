// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChatGoal } from "./api/chats";
import { chatGoalQueryOptions } from "./chat-goal-query";

vi.mock("./api/chats", () => ({ getChatGoal: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("goal status refresh", () => {
  it("discovers a goal after a queued submission initially reads no goal, then observes pause and clear", async () => {
    vi.useFakeTimers();
    const goal = {
      threadId: "thread",
      objective: "Finish the work",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(getChatGoal).mockResolvedValue({ goal: null });
    const client = new QueryClient();
    const observer = new QueryObserver(
      client,
      chatGoalQueryOptions("chat", "running"),
    );
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(observer.getCurrentResult().data).toEqual({ goal: null });
      vi.mocked(getChatGoal).mockResolvedValue({ goal });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(observer.getCurrentResult().data?.goal?.status).toBe("active");
      vi.mocked(getChatGoal).mockResolvedValue({
        goal: { ...goal, status: "paused" },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(observer.getCurrentResult().data?.goal?.status).toBe("paused");
      vi.mocked(getChatGoal).mockResolvedValue({ goal: null });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(observer.getCurrentResult().data).toEqual({ goal: null });
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("recovers from a worker reconnect failure without requiring another message", async () => {
    vi.useFakeTimers();
    vi.mocked(getChatGoal).mockRejectedValue(new Error("Worker is offline"));
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      ...chatGoalQueryOptions("chat", "idle"),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(observer.getCurrentResult().isError).toBe(true);
      vi.mocked(getChatGoal).mockResolvedValue({ goal: null });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(observer.getCurrentResult().isSuccess).toBe(true);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
