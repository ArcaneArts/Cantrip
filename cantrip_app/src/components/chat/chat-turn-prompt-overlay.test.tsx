import type { ChatMessage } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  activeChatTurnPrompt,
  CHAT_TURN_PROMPT_GLITCH_CONFIG,
  chatTurnPromptSummary,
  ChatTurnPromptOverlay,
} from "./chat-turn-prompt-overlay";

function message(text: string): ChatMessage {
  return {
    id: "user-1",
    chatId: "chat-1",
    contextKind: "project",
    worktreeId: "worktree-primary",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 1,
    role: "user",
    mode: "default",
    createdAt: "2026-08-23T12:00:00.000Z",
    content: [{ type: "text", text }],
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

describe("active chat turn prompt", () => {
  const anchors = [
    { height: 60, messageId: "user-1", offsetTop: 24 },
    { height: 80, messageId: "user-2", offsetTop: 400 },
  ];

  it("appears only after the current turn's user message leaves the viewport", () => {
    expect(activeChatTurnPrompt(anchors, 0)).toEqual({
      messageId: null,
      visible: false,
    });
    expect(activeChatTurnPrompt(anchors, 24)).toEqual({
      messageId: "user-1",
      visible: false,
    });
    expect(activeChatTurnPrompt(anchors, 83)).toEqual({
      messageId: "user-1",
      visible: false,
    });
    expect(activeChatTurnPrompt(anchors, 84)).toEqual({
      messageId: "user-1",
      visible: true,
    });
  });

  it("hides while the next turn's original prompt is visible", () => {
    expect(activeChatTurnPrompt(anchors, 399)).toEqual({
      messageId: "user-1",
      visible: true,
    });
    expect(activeChatTurnPrompt(anchors, 400)).toEqual({
      messageId: "user-2",
      visible: false,
    });
    expect(activeChatTurnPrompt(anchors, 480)).toEqual({
      messageId: "user-2",
      visible: true,
    });
  });
});

describe("chat turn prompt overlay", () => {
  it("compacts multiline prompts for the floating header", () => {
    expect(
      chatTurnPromptSummary(message("Inspect the project\n\nthen fix it")),
    ).toBe("Inspect the project then fix it");
  });

  it("does not retain a hidden prompt for a fade-out transition", () => {
    const markup = renderToStaticMarkup(
      <ChatTurnPromptOverlay
        message={message("Keep this request in view")}
        visible={false}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders the visible prompt as a blurred primary-outlined glitch card", () => {
    const markup = renderToStaticMarkup(
      <ChatTurnPromptOverlay message={message("Original prompt")} visible />,
    );

    expect(markup).toContain("data-chat-turn-prompt-overlay");
    expect(markup).toContain("data-elite-reveal");
    expect(markup).toContain("border-primary/35");
    expect(markup).toContain("bg-background/75");
    expect(markup).toContain("backdrop-blur-2xl");
    expect(markup).not.toContain("transition-");
  });

  it("uses a short box-oriented glitch without staggered delay", () => {
    expect(CHAT_TURN_PROMPT_GLITCH_CONFIG).toMatchObject({
      glitchCountMax: 5,
      glitchCountMin: 3,
      glitchShowMs: 16,
      staggerSpreadMs: 0,
      variants: ["outline", "chromatic", "spatial-shift", "scanline"],
    });
  });
});
