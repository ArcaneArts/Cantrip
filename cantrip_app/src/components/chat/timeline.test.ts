import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildChatTimeline, formatElapsedTime } from "./timeline";

function message(
  id: string,
  role: ChatMessage["role"],
  createdAt: string,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    worktreeId: "worktree-primary",
    executionLaneId: null,
    sequence: 1,
    role,
    mode: "default",
    createdAt,
    content,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
  };
}

describe("chat activity timeline", () => {
  it("groups a completed turn and measures user-to-response time", () => {
    const messages = [
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Do the work" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm check",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: null,
          },
        },
      ]),
      message("files", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "fileChange",
            id: "files-1",
            status: "completed",
            changes: [{ path: "src/App.tsx", kind: "update" }],
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:01:44.000Z", [
        { type: "text", text: "Finished." },
      ]),
    ];

    const timeline = buildChatTimeline(messages);
    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      activities: [{ id: "command-1" }, { id: "files-1" }],
      startedAt: "2026-08-07T12:00:00.000Z",
      endedAt: "2026-08-07T12:01:44.000Z",
    });
    expect(
      formatElapsedTime("2026-08-07T12:00:00.000Z", "2026-08-07T12:01:44.000Z"),
    ).toBe("1m 44s");
  });

  it("keeps an active turn expanded by leaving its end open", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Do the work" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pnpm check",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        },
      ]),
    ]);

    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      endedAt: null,
    });
  });

  it("preserves commentary phase and closes a recovered group from turn timing", () => {
    const timeline = buildChatTimeline([
      message("commentary", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "text",
          text: "I’m inspecting the runtime schema.",
          phase: "commentary",
        },
      ]),
      message("reasoning", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "activity",
          activity: {
            type: "reasoning",
            id: "reasoning-1",
            status: "completed",
            summary: ["Compared the event unions."],
          },
        },
      ]),
      message("summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:turn-1:summary",
            status: "completed",
            durationMs: 3_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_003,
          },
        },
      ]),
    ]);

    expect(timeline[0]).toMatchObject({
      type: "message",
      message: { content: [{ phase: "commentary" }] },
    });
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      endedAt: "2026-08-07T12:00:03.000Z",
    });
  });

  it("folds trailing turn metrics into the activity group before the final answer", () => {
    const timeline = buildChatTimeline([
      message("user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Inspect the runtime" },
      ]),
      message("command", "assistant", "2026-08-07T12:00:01.000Z", [
        {
          type: "activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "codex --version",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: "codex-cli 0.146.1",
          },
        },
      ]),
      message("answer", "assistant", "2026-08-07T12:00:02.000Z", [
        {
          type: "text",
          text: "The runtime is compatible.",
          phase: "final_answer",
        },
      ]),
      message("summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:turn-1:summary",
            status: "completed",
            durationMs: 2_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_002,
          },
        },
      ]),
    ]);

    expect(timeline).toHaveLength(3);
    expect(timeline[1]).toMatchObject({
      type: "activityGroup",
      activities: [{ type: "command" }, { type: "turnSummary" }],
    });
    expect(timeline[2]).toMatchObject({
      type: "message",
      message: { id: "answer" },
    });

    const simpleTimeline = buildChatTimeline([
      message("simple-user", "user", "2026-08-07T12:00:00.000Z", [
        { type: "text", text: "Say hello" },
      ]),
      message("simple-answer", "assistant", "2026-08-07T12:00:02.000Z", [
        { type: "text", text: "Hello", phase: "final_answer" },
      ]),
      message("simple-summary", "assistant", "2026-08-07T12:00:03.000Z", [
        {
          type: "activity",
          activity: {
            type: "turnSummary",
            id: "turn:simple:summary",
            status: "completed",
            durationMs: 2_000,
            startedAt: 1_786_104_000,
            completedAt: 1_786_104_002,
          },
        },
      ]),
    ]);
    expect(simpleTimeline.map((entry) => entry.type)).toEqual([
      "message",
      "activityGroup",
      "message",
    ]);
  });
});
