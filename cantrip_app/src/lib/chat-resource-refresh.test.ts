import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@cantrip/protocol";

import {
  chatResourceRefreshIntervalMs,
  chatTranscriptNeedsFastRefresh,
} from "./chat-resource-refresh";

const message = (
  sequence: number,
  role: ChatMessage["role"],
  text: string,
  phase?: "commentary" | "final_answer",
): ChatMessage => ({
  id: `message-${sequence}`,
  chatId: "chat-one",
  worktreeId: "worktree-one",
  executionLaneId: "lane-one",
  sequence,
  role,
  content: [{ type: "text", text, ...(phase ? { phase } : {}) }],
  mode: "default",
  reasoningEffort: null,
  modelId: "model-one",
  modelRouteId: "route-one",
  providerId: "provider-one",
  providerName: "Provider",
  providerModelName: "model",
  appliedReasoningEffort: null,
  reasoningAdjusted: false,
  createdAt: "2026-08-16T14:00:00.000Z",
});

describe("chatResourceRefreshIntervalMs", () => {
  it("keeps active turns fresh even while the live event stream is healthy", () => {
    expect(chatResourceRefreshIntervalMs("running", true)).toBe(3_000);
    expect(chatResourceRefreshIntervalMs("waiting-for-approval", true)).toBe(
      3_000,
    );
  });

  it("uses a slow safety refresh for idle live chats", () => {
    expect(chatResourceRefreshIntervalMs("idle", true)).toBe(30_000);
  });

  it("refreshes more often while the live event stream is degraded", () => {
    expect(chatResourceRefreshIntervalMs("idle", false)).toBe(10_000);
    expect(chatResourceRefreshIntervalMs("failed", false)).toBe(10_000);
  });

  it("refreshes a recent trailing user turn until a durable result appears", () => {
    const now = Date.parse("2026-08-16T14:01:00.000Z");
    const pending = [message(1, "user", "Hello")];
    expect(chatTranscriptNeedsFastRefresh(pending, now)).toBe(true);
    expect(chatResourceRefreshIntervalMs("idle", true, true)).toBe(3_000);

    expect(
      chatTranscriptNeedsFastRefresh(
        [...pending, message(2, "assistant", "Working", "commentary")],
        now,
      ),
    ).toBe(true);
    expect(
      chatTranscriptNeedsFastRefresh(
        [...pending, message(2, "assistant", "Done", "final_answer")],
        now,
      ),
    ).toBe(false);
    expect(
      chatTranscriptNeedsFastRefresh(
        [...pending, message(2, "system", "Agent failed: unavailable")],
        now,
      ),
    ).toBe(false);
  });

  it("does not poll abandoned historical turns forever", () => {
    expect(
      chatTranscriptNeedsFastRefresh(
        [message(1, "user", "Old question")],
        Date.parse("2026-08-16T15:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
