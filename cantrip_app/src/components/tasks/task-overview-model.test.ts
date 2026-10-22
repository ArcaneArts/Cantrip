import type { AgentActivity, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  taskExecutionMessages,
  taskOverviewMetrics,
} from "./task-overview-model";

function message(
  sequence: number,
  content: ChatMessage["content"],
  role: ChatMessage["role"] = "assistant",
): ChatMessage {
  return {
    id: `message-${sequence}`,
    chatId: "task",
    sequence,
    role,
    createdAt: new Date(sequence * 1_000).toISOString(),
    content,
  } as ChatMessage;
}
function edit(
  id: string,
  turnId = "turn-1",
  status: AgentActivity["status"] = "completed",
  sourceMethod = "item/completed",
): ChatMessage["content"][number] {
  return {
    type: "activity",
    activity: {
      type: "fileChange",
      id,
      status,
      correlation: {
        turnId,
        threadId: "root",
        sourceMethod,
        itemId: id,
        diagnosticId: null,
      },
      changes: [
        {
          path: "src/main.rs",
          kind: "update",
          diffPreview: "--- old\n+++ new\n@@ -1 +1 @@\n-old\n+new\n+more",
        },
      ],
    },
  };
}

describe("Task overview metrics", () => {
  it("counts autonomous goal cycles even without additional user messages", () => {
    expect(
      taskOverviewMetrics([
        message(1, [{ type: "text", text: "Work toward the goal" }], "user"),
        message(2, [edit("patch", "turn-1")]),
        message(3, [edit("patch", "turn-2")]),
        message(4, [edit("patch", "turn-3")]),
      ]).turns,
    ).toBe(3);
  });

  it("counts a subagent's work under its root turn", () => {
    const child = edit("child", "child-turn");
    if (child.type === "activity")
      child.activity.agentScope = {
        agentThreadId: "child",
        rootThreadId: "root",
        rootTurnId: "turn-1",
        parentThreadId: "root",
        agentPath: ["root", "child"],
        nickname: null,
        role: null,
        depth: 1,
        isRoot: false,
      };
    expect(
      taskOverviewMetrics([message(1, [edit("root", "turn-1"), child])]).turns,
    ).toBe(1);
  });
  it("counts separate native turns but not streamed messages or replayed edits", () => {
    const messages = [
      message(1, [{ type: "text", text: "Build it" }], "user"),
      message(2, [edit("patch")]),
      message(3, [edit("patch")]),
      message(4, [{ type: "text", text: "Continue" }], "user"),
      message(5, [edit("patch", "turn-2")]),
    ];
    expect(taskOverviewMetrics(messages)).toEqual({
      turns: 2,
    });
  });

  it("scopes implementation counters after planning history", () => {
    const messages = [message(1, [edit("plan")]), message(3, [edit("impl")])];
    expect(
      taskExecutionMessages(messages, new Date(2_000).toISOString()),
    ).toEqual([messages[1]]);
    expect(taskExecutionMessages(messages, null)).toEqual(messages);
  });

  it("does not count an unsent/unadmitted prompt as an executed turn", () => {
    expect(
      taskOverviewMetrics([
        message(1, [{ type: "text", text: "Queued prompt" }], "user"),
      ]).turns,
    ).toBe(0);
  });
});
