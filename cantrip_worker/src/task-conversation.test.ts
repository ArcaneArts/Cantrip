import { describe, expect, it } from "vitest";
import { decryptTaskMessageProtectedContent } from "@cantrip/crypto";
import { protectChatTurn } from "./chat-message-encryption.js";
import {
  protectTaskConversationMessage,
  openTaskConversationPrompt,
  encryptTaskTurnResult,
} from "./task-operation.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { taskMessageRelayResultSchema } from "@cantrip/protocol/tasks";

const ownerId = "task-conversation-owner";
const taskKey = new Uint8Array(32).fill(5);
const chatKey = new Uint8Array(32).fill(7);
const service = {
  ownerId: () => ownerId,
  componentKey: (component: string) => ({
    key: new Uint8Array(component === "task-content" ? taskKey : chatKey),
    keyRevision: 1,
  }),
} as unknown as WorkerEncryptionService;

describe("encrypted Task conversation", () => {
  it("converts composer input to Task ciphertext without exposing prose in the relay", async () => {
    const input = await protectChatTurn({
      service,
      text: "SENTINEL what is blocking you?",
      mode: "default",
      modelId: "model",
      reasoningEffort: null,
      idempotencyKey: "conversation",
      messageId: "11111111-1111-4111-8111-111111111111",
      promptId: "22222222-2222-4222-8222-222222222222",
    });
    const message = await protectTaskConversationMessage({
      message: input.message,
      service,
    });
    expect(JSON.stringify(message)).not.toContain("SENTINEL");
    expect(message).toMatchObject({
      id: input.message.id,
      idempotencyKey: "conversation",
      classification: { role: "user", mode: "default" },
    });
    expect(message.protectedContent).not.toEqual(
      input.message.protectedContent,
    );
    expect(await openTaskConversationPrompt({ message, service })).toBe(
      "SENTINEL what is blocking you?",
    );
    await expect(
      openTaskConversationPrompt({ message: input.message, service }),
    ).rejects.toThrow();
    await expect(
      protectTaskConversationMessage({
        message: {
          ...input.message,
          classification: { ...input.message.classification, mode: "goal" },
        },
        service,
      }),
    ).rejects.toThrow();
  });

  it("keeps ordinary conversation replies in default mode", async () => {
    const result = await encryptTaskTurnResult({
      ownerId,
      getComponentKey: () => service.componentKey("task-content"),
      messageId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "assistant:conversation",
      mode: "default",
      result: {
        threadId: "thread",
        turnId: "turn",
        status: "completed",
        text: "SENTINEL blocker explanation",
      },
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    const { message } = taskMessageRelayResultSchema.parse(
      result.structuredResult,
    );
    expect(message.classification.mode).toBe("default");
    const opened = await decryptTaskMessageProtectedContent({
      ownerId,
      messageId: message.id,
      keyRevision: 1,
      componentKey: taskKey,
      encrypted: message.protectedContent,
      publicClassification: message.classification,
    });
    expect(opened.content).toEqual([
      {
        type: "text",
        text: "SENTINEL blocker explanation",
        phase: "final_answer",
      },
    ]);
  });
});
