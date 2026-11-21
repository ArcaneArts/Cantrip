import { describe, expect, it } from "vitest";
import { decryptTaskMessageProtectedContent } from "@cantrip/crypto";
import { protectChatTurn } from "./chat-message-encryption.js";
import {
  protectTaskConversationMessage,
  openTaskConversationPrompt,
  encryptTaskTurnResult,
  EncryptedTaskEventSealer,
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
  it.each(["default", "goal"] as const)(
    "reuses exact published %s ciphertext only when the server opts in",
    async (mode) => {
      const sealer = new EncryptedTaskEventSealer(service, mode);
      const published = await sealer.message({
        id: "native-item",
        text: "SENTINEL completed response",
        phase: null,
        correlation: {
          sourceMethod: "item/completed",
          diagnosticId: null,
          threadId: "thread",
          turnId: "turn",
          itemId: "native-item",
        },
      });
      const result = {
        threadId: "thread",
        turnId: "turn",
        status: "completed" as const,
        text: "SENTINEL completed response",
      };
      const input = {
        ownerId,
        messageId: "33333333-3333-4333-8333-333333333333",
        idempotencyKey: "assistant:input",
        mode,
        result,
        eventSealer: sealer,
      };
      const reused = await encryptTaskTurnResult({
        ...input,
        reusePublishedResponse: true,
        getComponentKey: () => {
          throw new Error("No new encryption is needed.");
        },
      });
      expect(
        taskMessageRelayResultSchema.parse(reused.structuredResult).message,
      ).toEqual(published.message);
      expect(JSON.stringify(reused)).not.toContain("SENTINEL");
      const legacy = await encryptTaskTurnResult({
        ...input,
        getComponentKey: () => service.componentKey("task-content"),
      });
      expect(
        taskMessageRelayResultSchema.parse(legacy.structuredResult).message.id,
      ).toBe(input.messageId);
      const unrelated = await encryptTaskTurnResult({
        ...input,
        reusePublishedResponse: true,
        result: { ...result, turnId: "different-turn" },
        getComponentKey: () => service.componentKey("task-content"),
      });
      expect(
        taskMessageRelayResultSchema.parse(unrelated.structuredResult).message
          .id,
      ).toBe(input.messageId);
    },
  );
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
