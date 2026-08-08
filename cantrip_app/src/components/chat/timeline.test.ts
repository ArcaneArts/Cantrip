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
});
