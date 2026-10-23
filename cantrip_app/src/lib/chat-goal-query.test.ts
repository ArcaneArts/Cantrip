// @vitest-environment jsdom
import {
  QueryClient,
  QueryObserver,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChatGoal } from "./api/chats";
import { chatGoalQueryOptions, useChatGoalQuery } from "./chat-goal-query";

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
      await vi.advanceTimersByTimeAsync(30_000);
      expect(observer.getCurrentResult().isSuccess).toBe(true);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("retains a failure while retry is pending, clears it only on success, and isolates chats", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.mocked(getChatGoal).mockRejectedValue(new Error("Worker offline"));
    const client = new QueryClient();
    function Probe({ chatId }: { chatId: string }) {
      const query = useChatGoalQuery(chatId, "idle", true);
      return createElement("output", {
        error: query.statusError?.message ?? null,
      });
    }
    const view = (chatId: string) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, { chatId }),
      );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(view("one"));
    });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(renderer.root.findByType("output").props.error).toBe(
        "Worker offline",
      );
      let resolve!: (result: { goal: null }) => void;
      vi.mocked(getChatGoal).mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await act(async () => {
        void client.refetchQueries({ queryKey: ["goal", "one"] });
      });
      expect(renderer.root.findByType("output").props.error).toBe(
        "Worker offline",
      );
      await act(async () => {
        resolve({ goal: null });
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(renderer.root.findByType("output").props.error).toBeNull();
      await act(async () => {
        renderer.update(view("two"));
      });
      expect(renderer.root.findByType("output").props.error).toBeNull();
    } finally {
      await act(() => renderer.unmount());
      client.clear();
    }
  });
});
