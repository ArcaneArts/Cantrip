import {
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import {
  EncryptedChatEventSealer,
  encryptChatTurnResult,
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

  it("exposes exact usage telemetry while keeping the activity encrypted", async () => {
    const ownerId = "owner-chat-usage";
    const componentKey = new Uint8Array(32).fill(9);
    const service = {
      ownerId: () => ownerId,
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
    } as unknown as WorkerEncryptionService;
    const usage = {
      totalTokens: 1_200,
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 25,
      outputTokens: 300,
      reasoningOutputTokens: 100,
    };
    const sealer = new EncryptedChatEventSealer(service, "chat-usage", {
      explanation: null,
      steps: [],
      question: null,
    });
    const event = await sealer.activity({
      type: "usage",
      id: "turn:turn-usage:usage",
      status: "completed",
      total: usage,
      last: usage,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
      correlation: {
        sourceMethod: "thread/tokenUsage/updated",
        diagnosticId: null,
        threadId: "thread-usage",
        turnId: "turn-usage",
        itemId: null,
      },
    });

    expect(event.telemetry).toEqual({
      kind: "usage",
      usage,
      modelContextWindow: 128_000,
      contextUsedPercent: 12.5,
      turnId: "turn-usage",
    });
    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: event.message.id,
        keyRevision: 1,
        componentKey,
        encrypted: event.message.protectedContent,
        publicClassification: event.message.classification,
      }),
    ).resolves.toMatchObject({
      content: [{ type: "activity", activity: { type: "usage", last: usage } }],
    });

    const commandEvent = await sealer.activity({
      type: "command",
      id: "command-1",
      status: "completed",
      command: "secret command",
      cwd: "/secret/path",
      exitCode: 0,
      output: null,
    });
    expect(commandEvent.telemetry).toEqual({
      kind: "activity",
      activityType: "command",
      turnId: null,
    });
    expect(JSON.stringify(commandEvent.telemetry)).not.toContain("secret");

    const result = await encryptChatTurnResult({
      idempotencyKey: "assistant:usage",
      messageId: "22222222-2222-4222-8222-222222222222",
      result: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        text: "Completed with measured usage.",
        measuredUsage: usage,
        status: "completed",
      },
      service,
    });
    expect(result.measuredUsage).toEqual(usage);
  });
});
