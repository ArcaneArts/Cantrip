import type { AgentScope, ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  canFailOverRoute,
  continuationPrompt,
} from "../src/chats/execution-helpers.js";

const rootScope: AgentScope = {
  agentThreadId: "root-thread",
  rootThreadId: "root-thread",
  parentThreadId: null,
  rootTurnId: "root-turn",
  agentPath: ["root"],
  nickname: null,
  role: null,
  depth: 0,
  isRoot: true,
};

const childScope: AgentScope = {
  ...rootScope,
  agentThreadId: "child-thread",
  parentThreadId: "root-thread",
  agentPath: ["root", "Scout"],
  nickname: "Scout",
  role: "explorer",
  depth: 1,
  isRoot: false,
};

function message(
  id: string,
  sequence: number,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id,
    chatId: "chat-one",
    worktreeId: "worktree-one",
    executionLaneId: null,
    sequence,
    role: "assistant",
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
    createdAt: new Date(sequence * 1_000).toISOString(),
  };
}

describe("chat continuation projection", () => {
  it("does not replay child-only transcript records as root history", () => {
    const prompt = continuationPrompt(
      [
        message("child", 1, [
          {
            type: "text",
            text: "PRIVATE CHILD RESULT",
            agentScope: childScope,
          },
        ]),
        message("root", 2, [
          { type: "text", text: "Root result", agentScope: rootScope },
        ]),
      ],
      "Continue root work",
    );

    expect(prompt).toContain("Root result");
    expect(prompt).toContain("Continue root work");
    expect(prompt).not.toContain("PRIVATE CHILD RESULT");
  });
});

describe("chat route failover", () => {
  it("treats model capacity as a route-local failure", () => {
    expect(
      canFailOverRoute(
        new Error(
          "Selected model is at capacity. Please try a different model.",
        ),
      ),
    ).toBe(true);
  });
});
