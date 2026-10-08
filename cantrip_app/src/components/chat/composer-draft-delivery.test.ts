import {
  clearSensitiveBytes,
  decryptAttachmentChunk,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { expect, it } from "vitest";
import {
  openAttachmentOpaqueSummary,
  protectAttachmentUpload,
} from "@/lib/attachment-encryption";
import {
  openChatComposerDraft,
  protectChatComposerDraft,
} from "@/lib/chat-composer-draft-encryption";
import {
  createEncryptedChatTurn,
  openChatMessageOpaqueSummary,
} from "@/lib/chat-message-encryption";
import { ClientEncryptionService } from "@/lib/client-encryption";
import type { ClientSessionContext } from "@/lib/client-session";
import {
  composerDraftWithAttachments,
  restoreComposerDraftAttachments,
} from "./composer-draft-attachments";

it("delivers every character once from a reloaded attachment-only draft to a deterministic runtime fixture", async () => {
  const ownerId = "owner-draft-delivery";
  const serverId = "server-draft-delivery";
  const chatId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "22222222-2222-4222-8222-222222222222";
  const operationId = "33333333-3333-4333-8333-333333333333";
  const createdAt = "2026-10-08T12:00:00.000Z";
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  const options = {
    service,
    session: () =>
      ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
  };
  const text =
    "WQA_LARGE_PASTE50_START\n" +
    "0123456789abcdef".repeat(320) +
    "\nWQA_LARGE_PASTE50_END";
  expect(text).toHaveLength(5166);
  const upload = await protectAttachmentUpload(
    {
      attachmentId,
      operationId,
      chatId,
      bytes: new TextEncoder().encode(text),
      fileName: "pasted-text.txt",
      mimeType: "text/plain",
      kind: "text",
      source: "paste",
      previewText: text,
    },
    options,
  );
  const attachment = await openAttachmentOpaqueSummary(
    {
      id: attachmentId,
      chatId,
      sizeBytes: 5166,
      status: "ready",
      protectedMetadata: upload.protectedMetadata,
      createdAt,
    },
    options,
  );
  const draft = composerDraftWithAttachments(
    { text: "", mode: "default", reasoningEffort: null },
    [
      {
        attachment,
        contentUrl: "unused",
        error: null,
        localPreview: false,
        uploading: false,
      },
    ],
  );
  expect(draft).not.toBeNull();
  const state = await protectChatComposerDraft(chatId, draft!, options);
  const restored = await openChatComposerDraft(
    chatId,
    JSON.parse(JSON.stringify({ chatId, state, updatedAt: createdAt })),
    options,
  );
  const ready = restoreComposerDraftAttachments(
    chatId,
    restored,
    (id) => `/api/attachments/${id}/content`,
  );
  const turn = await createEncryptedChatTurn(
    {
      attachments: ready.map((item) => item.attachment),
      idempotencyKey: "draft-delivery",
      messageId: "44444444-4444-4444-8444-444444444444",
      promptId: "55555555-5555-4555-8555-555555555555",
      mode: restored!.mode,
      modelId: "scripted-fixture",
      reasoningEffort: null,
      text: restored!.text,
    },
    options,
  );
  expect(turn.message.classification.attachmentIds).toEqual([attachmentId]);
  expect(JSON.stringify({ upload, state, turn })).not.toContain(
    "WQA_LARGE_PASTE50_START",
  );
  const message = await openChatMessageOpaqueSummary(
    {
      id: turn.message.id,
      chatId,
      worktreeId: "fixture-root",
      executionLaneId: "fixture-lane",
      sequence: 1,
      role: turn.message.classification.role,
      mode: turn.message.classification.mode,
      attachmentIds: turn.message.classification.attachmentIds,
      protectedContent: turn.message.protectedContent,
      modelId: "scripted-fixture",
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      idempotencyKey: turn.message.idempotencyKey,
      createdAt,
    },
    options,
  );
  // A bounded scripted consumer reads exactly the attachment references delivered in the real encrypted turn.
  const delivered: string[] = [];
  const componentKey = service.componentKey({
    component: "attachment-content",
    identity: { ownerId, serverId },
    keyRevision: 1,
  });
  try {
    for (const content of message.content) {
      if (content.type !== "attachment") continue;
      expect(content.attachment.id).toBe(attachmentId);
      const chunks = await Promise.all(
        upload.chunks.map((encrypted, sequence) =>
          decryptAttachmentChunk({
            ownerId,
            chatId,
            attachmentId: content.attachment.id,
            operationId,
            direction: "upload",
            sequence,
            keyRevision: 1,
            componentKey,
            encrypted,
          }),
        ),
      );
      delivered.push(
        chunks.map((bytes) => new TextDecoder().decode(bytes)).join(""),
      );
      chunks.forEach(clearSensitiveBytes);
    }
  } finally {
    clearSensitiveBytes(componentKey);
  }
  expect(delivered).toEqual([text]);
});
