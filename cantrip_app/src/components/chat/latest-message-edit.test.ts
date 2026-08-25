import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  editableMessageAttachments,
  editableMessageText,
  latestEditableUserMessage,
} from "./latest-message-edit";

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    contextKind: "project",
    worktreeId: "worktree-1",
    scratchRootId: null,
    executionLaneId: null,
    sequence: Number(id.replace(/\D/gu, "")) || 1,
    role,
    content: [{ type: "text", text }],
    mode: "default",
    reasoningEffort: null,
    modelId: "model-1",
    modelRouteId: "route-1",
    providerId: "provider-1",
    providerName: "ChatGPT",
    providerModelName: "GPT",
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: "2026-08-22T12:00:00.000Z",
  };
}

describe("latest editable chat message", () => {
  const first = message("message-1", "user", "First");
  const assistant = message("message-2", "assistant", "Response");
  const latest = message("message-3", "user", "Latest");
  const interrupted = message("message-4", "system", "Turn interrupted.");

  it("selects only the newest user turn after it stops", () => {
    expect(
      latestEditableUserMessage(
        [first, assistant, latest, interrupted],
        "idle",
        false,
      )?.id,
    ).toBe(latest.id);
    expect(
      latestEditableUserMessage([first, assistant], "failed", false)?.id,
    ).toBe(first.id);
  });

  it("does not expose editing while running, awaiting approval, or paused", () => {
    expect(latestEditableUserMessage([latest], "running", false)).toBeNull();
    expect(
      latestEditableUserMessage([latest], "waiting-for-approval", false),
    ).toBeNull();
    expect(latestEditableUserMessage([latest], "idle", true)).toBeNull();
  });

  it("does not offer a retry when the original runtime is unknown", () => {
    expect(
      latestEditableUserMessage(
        [{ ...latest, modelRouteId: null }],
        "idle",
        false,
      ),
    ).toBeNull();
  });

  it("preserves text and attachments for the replacement turn", () => {
    const attachment = {
      id: "attachment-1",
      chatId: "chat-1",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      kind: "text" as const,
      source: "file" as const,
      status: "ready" as const,
      previewText: "hello",
      createdAt: "2026-08-22T12:00:00.000Z",
    };
    const rich = {
      ...latest,
      content: [
        { type: "text" as const, text: "One" },
        { type: "attachment" as const, attachment },
        { type: "text" as const, text: "Two" },
      ],
    };
    expect(editableMessageText(rich)).toBe("One\n\nTwo");
    expect(editableMessageAttachments(rich)).toEqual([attachment]);
  });
});
