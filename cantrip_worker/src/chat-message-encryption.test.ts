import {
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import {
  protectChatTurn,
  reprotectChatMessages,
} from "./chat-message-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

describe("worker chat message encryption", () => {
  it("protects queued automation turns and re-encrypts fork copies", async () => {
    const ownerId = "owner-chat-encryption";
    const componentKey = new Uint8Array(32).fill(7);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const turn = await protectChatTurn({
      promptId: "11111111-1111-4111-8111-111111111111",
      messageId: "22222222-2222-4222-8222-222222222222",
      text: "Run the unattended automation.",
      mode: "default",
      modelId: "model-one",
      reasoningEffort: null,
      idempotencyKey: "automation:one",
      service,
    });
    await expect(
      decryptQueuedPromptProtectedContent({
        ownerId,
        promptId: turn.queuedPrompt.id,
        keyRevision: 1,
        componentKey,
        encrypted: turn.queuedPrompt.protectedContent,
        publicClassification: turn.queuedPrompt.classification,
      }),
    ).resolves.toMatchObject({ text: "Run the unattended automation." });

    const [copy] = await reprotectChatMessages({
      messages: [
        {
          source: {
            ...turn.message.classification,
            id: turn.message.id,
            chatId: "chat-one",
            worktreeId: "worktree-one",
            executionLaneId: null,
            sequence: 1,
            protectedContent: turn.message.protectedContent,
            modelId: null,
            modelRouteId: null,
            providerId: null,
            providerName: null,
            providerModelName: null,
            reasoningEffort: null,
            appliedReasoningEffort: null,
            reasoningAdjusted: false,
            idempotencyKey: turn.message.idempotencyKey,
            createdAt: "2026-08-20T12:00:00.000Z",
          },
          id: "33333333-3333-4333-8333-333333333333",
          idempotencyKey: "fork:one",
        },
      ],
      service,
    });
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: copy!.id,
        keyRevision: 1,
        componentKey,
        encrypted: copy!.protectedContent,
        publicClassification: copy!.classification,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Run the unattended automation." }],
    });
  });
});
