import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { AgentTranscriptEntry } from "./agent-turn-projection";
import {
  editedFilesByAssistantMessage,
  messageFileSummary,
} from "./message-file-summary";

function message(
  id: string,
  role: ChatMessage["role"],
  content: ChatMessage["content"],
  sequence: number,
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    contextKind: "project",
    worktreeId: "worktree-1",
    scratchRootId: null,
    executionLaneId: null,
    sequence,
    role,
    content,
    mode: "default",
    reasoningEffort: null,
    modelId: "model-1",
    modelRouteId: "route-1",
    providerId: "provider-1",
    providerName: "Provider",
    providerModelName: "Model",
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: `2026-09-02T12:00:0${sequence}.000Z`,
  };
}

describe("assistant message file summaries", () => {
  it("combines edited and referenced files and reports changed line counts", () => {
    const response = message(
      "response",
      "assistant",
      [
        {
          type: "text",
          phase: "final_answer",
          text: "Updated [the entrypoint](</repo/src/app.ts:12>) and consulted [README](./README.md).",
        },
      ],
      3,
    );
    const summary = messageFileSummary(response, [
      {
        path: "src/app.ts",
        kind: "update",
        diffPreview:
          "--- a/src/app.ts\n+++ b/src/app.ts\n+new line\n-old line\n+another line",
      },
    ]);

    expect(summary).toMatchObject({
      additions: 2,
      deletions: 1,
      title: "Files Edited and Referenced",
    });
    expect(summary?.entries).toEqual([
      expect.objectContaining({
        additions: 2,
        deletions: 1,
        edited: true,
        path: "src/app.ts",
        referenced: true,
      }),
      expect.objectContaining({
        edited: false,
        path: "README.md",
        referenced: true,
      }),
    ]);
  });

  it("associates the turn's latest file changes with its final response", () => {
    const response = message(
      "response",
      "assistant",
      [{ type: "text", phase: "final_answer", text: "Done." }],
      3,
    );
    const entries: AgentTranscriptEntry[] = [
      {
        type: "timeline",
        entry: {
          type: "message",
          message: message(
            "prompt",
            "user",
            [{ type: "text", text: "Change it" }],
            1,
          ),
          turnMetadata: null,
        },
      },
      {
        type: "timeline",
        entry: {
          type: "activityGroup",
          kind: "turn",
          key: "turn:one",
          messages: [
            message(
              "files",
              "assistant",
              [
                {
                  type: "activity",
                  activity: {
                    type: "fileChange",
                    id: "files",
                    status: "completed",
                    changes: [{ path: "src/app.ts", kind: "update" }],
                  },
                },
              ],
              2,
            ),
          ],
          startedAt: "2026-09-02T12:00:01.000Z",
          endedAt: "2026-09-02T12:00:03.000Z",
          turnId: "turn-1",
          turnKey: "runtime:turn-1",
        },
      },
      {
        type: "timeline",
        entry: { type: "message", message: response, turnMetadata: null },
      },
    ];

    expect(editedFilesByAssistantMessage(entries).get(response.id)).toEqual([
      expect.objectContaining({ path: "src/app.ts" }),
    ]);
    expect(
      messageFileSummary(
        response,
        editedFilesByAssistantMessage(entries).get(response.id) ?? [],
      )?.title,
    ).toBe("Files Edited");
  });

  it("does not show a summary before a streaming response completes", () => {
    const response = message(
      "response",
      "assistant",
      [{ type: "text", text: "See [README](README.md)", streaming: true }],
      1,
    );
    expect(messageFileSummary(response, [])).toBeNull();
  });
});
