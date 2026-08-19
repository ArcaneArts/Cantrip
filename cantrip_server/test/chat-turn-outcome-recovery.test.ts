import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatTurnOutcomeRecoveryScheduler,
  chatTurnOutcomeRecoveryKey,
  outcomeBelongsToLatestLaneTurn,
  shouldRecoverChatTurnOutcome,
} from "../src/chats/turn-outcome-recovery.js";

afterEach(() => {
  vi.useRealTimers();
});

const activeLane = {
  state: "active",
  workerId: "worker-1",
  worktreeId: "worktree-1",
};

describe("chat turn outcome recovery", () => {
  it("uses one key for scheduling and cancelling a turn recovery", () => {
    expect(chatTurnOutcomeRecoveryKey("worker-1", "chat-1", "message-1")).toBe(
      "worker-1:chat-1:message-1",
    );
  });

  it("only recovers an outcome while its original lane is active", () => {
    expect(
      shouldRecoverChatTurnOutcome(activeLane, "worker-1", "worktree-1"),
    ).toBe(true);
    expect(
      shouldRecoverChatTurnOutcome(
        { ...activeLane, state: "suspended" },
        "worker-1",
        "worktree-1",
      ),
    ).toBe(false);
    expect(
      shouldRecoverChatTurnOutcome(activeLane, "worker-2", "worktree-1"),
    ).toBe(false);
    expect(
      shouldRecoverChatTurnOutcome(activeLane, "worker-1", "worktree-2"),
    ).toBe(false);
    expect(shouldRecoverChatTurnOutcome(null, "worker-1", "worktree-1")).toBe(
      false,
    );
  });

  it("does not schedule a durable recovery after normal completion settles the turn", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const scheduler = new ChatTurnOutcomeRecoveryScheduler(1_000, 60_000);
    scheduler.settle("turn-1");

    expect(scheduler.schedule("turn-1", recover)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(recover).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("cancels a scheduled durable recovery when the normal request completes", () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const scheduler = new ChatTurnOutcomeRecoveryScheduler(1_000, 60_000);
    expect(scheduler.schedule("turn-1", recover)).toBe(true);
    scheduler.settle("turn-1");

    vi.advanceTimersByTime(1_000);
    expect(recover).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("rejects an old outcome after a reused lane has a newer user turn", () => {
    const messages = [
      { id: "message-1", role: "user", executionLaneId: "lane-1" },
      { id: "assistant-1", role: "assistant", executionLaneId: "lane-1" },
      { id: "message-2", role: "user", executionLaneId: "lane-1" },
    ];
    expect(
      outcomeBelongsToLatestLaneTurn(messages, "lane-1", "message-1"),
    ).toBe(false);
    expect(
      outcomeBelongsToLatestLaneTurn(messages, "lane-1", "message-2"),
    ).toBe(true);
  });
});
