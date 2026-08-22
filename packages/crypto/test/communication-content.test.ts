import { describe, expect, it } from "vitest";

import {
  decryptChatMessageProtectedContent,
  decryptChatComposerDraftProtectedContent,
  decryptChatPlanProtectedContent,
  decryptInteractionRequestContent,
  decryptInteractionResponseContent,
  decryptQueuedPromptProtectedContent,
  encryptChatMessageProtectedContent,
  encryptChatComposerDraftProtectedContent,
  encryptChatPlanProtectedContent,
  encryptInteractionRequestContent,
  encryptInteractionResponseContent,
  encryptQueuedPromptProtectedContent,
  randomBytes,
} from "../src/index.js";

const ownerId = "owner-1";
const keyRevision = 3;

describe("communication trusted-endpoint encryption codecs", () => {
  it("round-trips messages, queues, and interaction request/response content", async () => {
    const chatKey = randomBytes(32);
    const interactionKey = randomBytes(32);
    const messageClassification = {
      role: "assistant" as const,
      mode: "default" as const,
      attachmentIds: [] as string[],
    };
    const promptClassification = {
      mode: "plan" as const,
      attachmentIds: ["attachment-1"],
    };
    const interactionClassification = { kind: "userInput" as const };
    const messageContent = {
      version: 1 as const,
      classification: messageClassification,
      content: [
        {
          type: "text",
          text: "Sentinel ordinary chat content",
          phase: "final_answer",
        },
      ],
    };
    const promptContent = {
      version: 1 as const,
      classification: promptClassification,
      text: "Sentinel queued prompt",
    };
    const draftContent = {
      version: 1 as const,
      text: "Sentinel unfinished draft",
      mode: "plan" as const,
      reasoningEffort: "high",
    };
    const requestContent = {
      version: 1 as const,
      classification: interactionClassification,
      payload: {
        kind: "userInput",
        questions: [{ id: "scope", question: "Encrypt this?" }],
      },
    };
    const responseContent = {
      version: 1 as const,
      classification: interactionClassification,
      response: {
        kind: "userInput",
        answers: { scope: { answers: ["Yes"] } },
      },
    };

    const message = await encryptChatMessageProtectedContent({
      ownerId,
      messageId: "message-1",
      keyRevision,
      componentKey: chatKey,
      content: messageContent,
    });
    const prompt = await encryptQueuedPromptProtectedContent({
      ownerId,
      promptId: "prompt-1",
      keyRevision,
      componentKey: chatKey,
      content: promptContent,
    });
    const draft = await encryptChatComposerDraftProtectedContent({
      ownerId,
      chatId: "chat-1",
      keyRevision,
      componentKey: chatKey,
      content: draftContent,
    });
    const request = await encryptInteractionRequestContent({
      ownerId,
      requestKey: "request-1",
      keyRevision,
      componentKey: interactionKey,
      content: requestContent,
    });
    const response = await encryptInteractionResponseContent({
      ownerId,
      requestKey: "request-1",
      keyRevision,
      componentKey: interactionKey,
      content: responseContent,
    });

    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: "message-1",
        keyRevision,
        componentKey: chatKey,
        encrypted: message,
        publicClassification: messageClassification,
      }),
    ).resolves.toEqual(messageContent);
    await expect(
      decryptQueuedPromptProtectedContent({
        ownerId,
        promptId: "prompt-1",
        keyRevision,
        componentKey: chatKey,
        encrypted: prompt,
        publicClassification: promptClassification,
      }),
    ).resolves.toEqual(promptContent);
    await expect(
      decryptChatComposerDraftProtectedContent({
        ownerId,
        chatId: "chat-1",
        keyRevision,
        componentKey: chatKey,
        encrypted: draft,
      }),
    ).resolves.toEqual(draftContent);
    await expect(
      decryptInteractionRequestContent({
        ownerId,
        requestKey: "request-1",
        keyRevision,
        componentKey: interactionKey,
        encrypted: request,
        publicClassification: interactionClassification,
      }),
    ).resolves.toEqual(requestContent);
    await expect(
      decryptInteractionResponseContent({
        ownerId,
        requestKey: "request-1",
        keyRevision,
        componentKey: interactionKey,
        encrypted: response,
        publicClassification: interactionClassification,
      }),
    ).resolves.toEqual(responseContent);
  });

  it("rejects a protected message replayed under another row ID", async () => {
    const componentKey = randomBytes(32);
    const classification = {
      role: "user" as const,
      mode: "default" as const,
      attachmentIds: [] as string[],
    };
    const encrypted = await encryptChatMessageProtectedContent({
      ownerId,
      messageId: "message-1",
      keyRevision,
      componentKey,
      content: {
        version: 1,
        classification,
        content: [{ type: "text", text: "Bound to message one" }],
      },
    });

    await expect(
      decryptChatMessageProtectedContent({
        ownerId,
        messageId: "message-2",
        keyRevision,
        componentKey,
        encrypted,
        publicClassification: classification,
      }),
    ).rejects.toThrow();
  });

  it("rejects a protected composer draft replayed under another chat", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptChatComposerDraftProtectedContent({
      ownerId,
      chatId: "chat-1",
      keyRevision,
      componentKey,
      content: {
        version: 1,
        text: "Private unfinished message",
        mode: "default",
        reasoningEffort: null,
      },
    });

    await expect(
      decryptChatComposerDraftProtectedContent({
        ownerId,
        chatId: "chat-2",
        keyRevision,
        componentKey,
        encrypted,
      }),
    ).rejects.toThrow();
  });

  it("round-trips Plan Mode state and binds it to the chat", async () => {
    const componentKey = randomBytes(32);
    const classification = { hasQuestion: true };
    const content = {
      version: 1 as const,
      classification,
      explanation: "SENTINEL private plan explanation",
      steps: [{ step: "Protect the plan", status: "inProgress" as const }],
      question: {
        id: "plan-question",
        threadId: "thread-one",
        turnId: "turn-one",
        itemId: "item-one",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Encrypt this?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Yes", description: "Encrypt it." }],
          },
        ],
        createdAt: "2026-08-20T12:00:00.000Z",
      },
    };
    const encrypted = await encryptChatPlanProtectedContent({
      ownerId,
      chatId: "chat-one",
      keyRevision,
      componentKey,
      content,
    });

    await expect(
      decryptChatPlanProtectedContent({
        ownerId,
        chatId: "chat-one",
        keyRevision,
        componentKey,
        encrypted,
        publicClassification: classification,
      }),
    ).resolves.toEqual(content);
    await expect(
      decryptChatPlanProtectedContent({
        ownerId,
        chatId: "chat-two",
        keyRevision,
        componentKey,
        encrypted,
        publicClassification: classification,
      }),
    ).rejects.toThrow();
  });
});
