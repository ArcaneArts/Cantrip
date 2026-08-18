import type { ChatMessage } from "@cantrip/protocol";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildChatHistoryLandmarks,
  CHAT_HISTORY_RAIL_MAX_LANDMARKS,
  CHAT_HISTORY_RAIL_MIN_TURNS,
  ChatHistoryRail,
} from "./chat-history-rail";

function message(
  id: string,
  role: ChatMessage["role"],
  sequence: number,
  text: string,
  phase?: "commentary" | "final_answer",
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    worktreeId: "worktree-primary",
    executionLaneId: null,
    sequence,
    role,
    mode: "default",
    createdAt: new Date(sequence * 1_000).toISOString(),
    content: [{ type: "text", text, ...(phase ? { phase } : {}) }],
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
  };
}

function conversation(turnCount: number): ChatMessage[] {
  return Array.from({ length: turnCount }, (_, index) => [
    message(
      `user-${index}`,
      "user",
      index * 3 + 1,
      `## Request ${index}\nPlease inspect [the project](https://example.com).`,
    ),
    message(
      `commentary-${index}`,
      "assistant",
      index * 3 + 2,
      `Inspecting turn ${index}`,
      "commentary",
    ),
    message(
      `answer-${index}`,
      "assistant",
      index * 3 + 3,
      `Finished turn ${index}`,
      "final_answer",
    ),
  ]).flat();
}

describe("chat history rail landmarks", () => {
  it("stays hidden until the conversation is large enough", () => {
    expect(
      buildChatHistoryLandmarks(conversation(CHAT_HISTORY_RAIL_MIN_TURNS - 1)),
    ).toEqual([]);
  });

  it("pairs each user request with its completed response", () => {
    const landmarks = buildChatHistoryLandmarks(
      conversation(CHAT_HISTORY_RAIL_MIN_TURNS),
    );

    expect(landmarks).toHaveLength(CHAT_HISTORY_RAIL_MIN_TURNS);
    expect(landmarks[0]).toMatchObject({
      messageId: "user-0",
      ordinal: 1,
      position: 0,
      summary: "Finished turn 0",
      title: "Request 0 Please inspect the project.",
    });
    expect(landmarks.at(-1)?.position).toBe(1);
  });

  it("uses current commentary while a turn is still in progress", () => {
    const messages = conversation(CHAT_HISTORY_RAIL_MIN_TURNS);
    messages.pop();
    const landmarks = buildChatHistoryLandmarks(messages);

    expect(landmarks.at(-1)?.summary).toBe(
      `Inspecting turn ${CHAT_HISTORY_RAIL_MIN_TURNS - 1}`,
    );
  });

  it("samples extreme histories while preserving their endpoints", () => {
    const turnCount = CHAT_HISTORY_RAIL_MAX_LANDMARKS + 43;
    const landmarks = buildChatHistoryLandmarks(conversation(turnCount));

    expect(landmarks).toHaveLength(CHAT_HISTORY_RAIL_MAX_LANDMARKS);
    expect(landmarks[0]?.messageId).toBe("user-0");
    expect(landmarks.at(-1)?.messageId).toBe(`user-${turnCount - 1}`);
    expect(landmarks.at(-1)?.position).toBe(1);
  });

  it("renders an accessible jump target for every visible landmark", () => {
    const markup = renderToStaticMarkup(
      <ChatHistoryRail
        messages={conversation(CHAT_HISTORY_RAIL_MIN_TURNS)}
        viewportRef={createRef<HTMLDivElement>()}
        withComposer
      />,
    );

    expect(markup).toContain('aria-label="Conversation history"');
    expect(markup).toContain('aria-label="Jump to turn 1: Request 0');
    expect(markup.match(/type="button"/g)).toHaveLength(
      CHAT_HISTORY_RAIL_MIN_TURNS,
    );
  });
});
