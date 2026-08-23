import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  formatRunningAgentDuration,
  resolveRunningAgentStartedAtMs,
} from "./chat-run-duration";

function message(
  role: ChatMessage["role"],
  createdAt: string,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id: `${role}:${createdAt}`,
    chatId: "chat-1",
    worktreeId: "worktree-1",
    executionLaneId: null,
    sequence: 1,
    role,
    mode: "default",
    content,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt,
  };
}

describe("running agent duration", () => {
  it("prefers the live turn start and accepts epoch seconds", () => {
    const startedAt = 1_787_486_400;
    expect(
      resolveRunningAgentStartedAtMs(
        [
          message("assistant", "2026-08-23T12:00:01.000Z", [
            {
              type: "activity",
              activity: {
                type: "turnSummary",
                id: "turn:1:summary",
                status: "running",
                durationMs: null,
                startedAt,
                completedAt: null,
              },
            },
          ]),
        ],
        "2026-08-23T12:00:00.000Z",
      ),
    ).toBe(startedAt * 1_000);

    const startedAtMs = startedAt * 1_000 + 250;
    expect(
      resolveRunningAgentStartedAtMs(
        [
          message("assistant", "2026-08-23T12:00:01.000Z", [
            {
              type: "activity",
              activity: {
                type: "turnSummary",
                id: "turn:2:summary",
                status: "running",
                durationMs: null,
                startedAt,
                startedAtMs,
                completedAt: null,
              },
            },
          ]),
        ],
        "2026-08-23T12:00:00.000Z",
      ),
    ).toBe(startedAtMs);
  });

  it("falls back to the latest turn anchor while activity is starting", () => {
    expect(
      resolveRunningAgentStartedAtMs(
        [
          message("assistant", "2026-08-23T11:59:00.000Z", [
            {
              type: "activity",
              activity: {
                type: "turnSummary",
                id: "turn:stale:summary",
                status: "running",
                durationMs: null,
                startedAt: 1_787_486_340,
                completedAt: null,
              },
            },
          ]),
          message("user", "2026-08-23T12:00:03.000Z", []),
        ],
        "2026-08-23T12:00:04.000Z",
      ),
    ).toBe(Date.parse("2026-08-23T12:00:03.000Z"));
    expect(resolveRunningAgentStartedAtMs([], "invalid")).toBeNull();
  });

  it("formats seconds, minutes, and hours", () => {
    expect(formatRunningAgentDuration(-1)).toBe("0s");
    expect(formatRunningAgentDuration(9_999)).toBe("9s");
    expect(formatRunningAgentDuration(69_000)).toBe("1m 9s");
    expect(formatRunningAgentDuration(3_669_000)).toBe("1h 1m 9s");
  });
});
