import type { ChatCommunication, ChatMessage } from "@cantrip/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentChatMessage } from "./agent-chat-message";
import { buildChatTimeline } from "./timeline";
import { latestEditableUserMessage } from "./latest-message-edit";

vi.mock("./markdown", () => ({
  Markdown: ({ children }: { children: string }) =>
    createElement("p", null, children),
}));
const communication: ChatCommunication = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  sourceChatId: "main",
  sourceTitle: "Main",
  targetChatId: "fixer",
  targetTitle: "Fixer",
  direction: "sent",
};
export function agentMessage(direction: "sent" | "received"): ChatMessage {
  return {
    id: "delivery",
    chatId: direction === "sent" ? "main" : "fixer",
    contextKind: "project",
    worktreeId: "primary",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 2,
    role: direction === "sent" ? "assistant" : "user",
    content: [
      {
        type: "text",
        text: "Please review this change.",
        chatCommunication: { ...communication, direction },
      },
    ],
    mode: "default",
    reasoningEffort: null,
    modelId: "model",
    modelRouteId: "route",
    providerId: null,
    providerName: null,
    providerModelName: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: "2026-11-02T00:00:00Z",
  };
}
describe("agent messages between chats", () => {
  it.each(["sent", "received"] as const)(
    "shows the entire %s message with explicit agent attribution",
    (direction) => {
      const message = agentMessage(direction);
      const html = renderToStaticMarkup(
        <AgentChatMessage
          message={message}
          communication={{ ...communication, direction }}
          onOpenFile={() => {}}
        />,
      );
      expect(html).toContain(
        direction === "sent" ? "Sent to Fixer" : "From Main",
      );
      expect(html).toContain("Please review this change.");
      expect(html).toContain(">Agent</span>");
      expect(html).not.toContain("<details");
    },
  );
  it("keeps sent messages outside collapsed work without treating them as the final answer", () => {
    const sent = agentMessage("sent");
    const work: ChatMessage = {
      ...sent,
      id: "thought",
      sequence: 1,
      content: [{ type: "text", text: "Reviewing", phase: "commentary" }],
    };
    const response: ChatMessage = {
      ...sent,
      id: "final",
      sequence: 3,
      content: [{ type: "text", text: "Finished", phase: "final_answer" }],
    };
    const timeline = buildChatTimeline([work, sent, response]);
    const found = timeline.find(
      (entry) => entry.type === "message" && entry.message.id === sent.id,
    );
    expect(found?.type).toBe("message");
    expect(
      timeline.some(
        (entry) =>
          entry.type === "activityGroup" &&
          entry.messages.some((message) => message.id === sent.id),
      ),
    ).toBe(false);
  });
  it("replaces the queued delivery receipt with its native prompt without duplicate bubbles", () => {
    const input = agentMessage("received");
    const receipt = {
      ...input,
      role: "assistant" as const,
      id: "receipt",
      sequence: 1,
    };
    const entries = buildChatTimeline([receipt, input]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "message",
      message: { id: input.id },
    });
    const pending = buildChatTimeline([receipt]);
    expect(pending).toMatchObject([
      { type: "message", message: { role: "assistant" } },
    ]);
  });
  it("does not offer to edit and resend another agent's message as a human", () => {
    expect(
      latestEditableUserMessage([agentMessage("received")], "idle", false),
    ).toBeNull();
  });
});
