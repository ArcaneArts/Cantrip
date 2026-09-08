import { generateAccountMasterKey } from "@cantrip/crypto";
import { encryptedQueuedPromptSchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  createEncryptedChatTurn,
  openChatMessageOpaqueSummary,
  openQueuedPromptOpaqueSummary,
  replaceEncryptedQueuedPrompt,
} from "./chat-message-encryption";

const ownerId = "owner-chat-message";
const serverId = "server-chat-message";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function readyService() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return service;
}

describe("ordinary chat trusted-endpoint encryption", () => {
  it("keeps the native input envelope and shared revision when editing or freezing a CLI queue entry", async () => {
    const options = { service: readyService(), session };
    const turn = await createEncryptedChatTurn(
      {
        attachments: [],
        idempotencyKey: "native-queue:item",
        messageId: "11111111-1111-4111-8111-111111111111",
        promptId: "22222222-2222-4222-8222-222222222222",
        mode: "default",
        modelId: "model-one",
        reasoningEffort: "high",
        text: "original input",
      },
      options,
    );
    const current = encryptedQueuedPromptSchema.parse({
      ...turn.queuedPrompt,
      protectedNativeInput: turn.queuedPrompt.protectedContent.envelope,
      nativeClientUserMessageId: "native-message-id",
      nativeAction: "literal",
      executionMethod: "turn/start",
      chatId: "chat-one",
      revision: 7,
      attachments: [],
      position: 0,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    });
    const edited = await replaceEncryptedQueuedPrompt(
      current,
      {
        attachments: [],
        frozen: true,
        mode: "default",
        reasoningEffort: "high",
        text: "edited input",
      },
      options,
    );
    expect(edited).toMatchObject({
      protectedNativeInput: current.protectedNativeInput,
      nativeClientUserMessageId: "native-message-id",
      nativeAction: "literal",
      executionMethod: "turn/start",
      frozen: true,
    });
    const opened = await openQueuedPromptOpaqueSummary(
      { ...current, ...edited },
      options,
    );
    expect(opened).toMatchObject({
      revision: 7,
      frozen: true,
      text: "edited input",
    });
    expect(JSON.stringify(edited)).not.toContain("edited input");
  });
  it("keeps submitted and queued prompt text opaque and opens both at the client", async () => {
    const options = { service: readyService(), session };
    const turn = await createEncryptedChatTurn(
      {
        attachments: [],
        idempotencyKey: "chat-turn:test",
        messageId: "11111111-1111-4111-8111-111111111111",
        mode: "plan",
        modelId: "model-one",
        promptId: "22222222-2222-4222-8222-222222222222",
        reasoningEffort: "high",
        customSubagentModel: true,
        subagentModelId: "model-child",
        subagentReasoningEffort: "medium",
        text: "SENTINEL private ordinary prompt",
      },
      options,
    );
    expect(JSON.stringify(turn)).not.toContain("SENTINEL");

    await expect(
      openChatMessageOpaqueSummary(
        {
          id: turn.message.id,
          chatId: "chat-one",
          worktreeId: "worktree-one",
          executionLaneId: "lane-one",
          sequence: 1,
          role: turn.message.classification.role,
          mode: turn.message.classification.mode,
          attachmentIds: turn.message.classification.attachmentIds,
          protectedContent: turn.message.protectedContent,
          modelId: "model-one",
          modelRouteId: null,
          providerId: null,
          providerName: null,
          providerModelName: null,
          reasoningEffort: "high",
          appliedReasoningEffort: null,
          reasoningAdjusted: false,
          idempotencyKey: turn.message.idempotencyKey,
          createdAt: "2026-08-20T12:00:00.000Z",
        },
        options,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "SENTINEL private ordinary prompt" }],
    });

    await expect(
      openQueuedPromptOpaqueSummary(
        {
          ...turn.queuedPrompt,
          chatId: "chat-one",
          attachments: [],
          position: 0,
          createdAt: "2026-08-20T12:00:00.000Z",
          updatedAt: "2026-08-20T12:00:00.000Z",
        },
        options,
      ),
    ).resolves.toMatchObject({
      text: "SENTINEL private ordinary prompt",
      customSubagentModel: true,
      subagentModelId: "model-child",
      subagentReasoningEffort: "medium",
    });
  });
});
