import { describe, expect, it } from "vitest";

import {
  chatTurnOutcomeRecoveryKey,
  shouldRecoverChatTurnOutcome,
} from "../src/chats/turn-outcome-recovery.js";

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
});
