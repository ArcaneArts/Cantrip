import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import type { ChatAttachmentSummary } from "@cantrip/protocol";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openChatComposerDraft,
  protectChatComposerDraft,
} from "./chat-composer-draft-encryption";

const ownerId = "owner-chat-draft";
const serverId = "server-chat-draft";
const chatId = "chat-one";

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

describe("chat composer draft encryption", () => {
  it("round-trips an unfinished draft without exposing its text", async () => {
    const options = { service: readyService(), session };
    const state = await protectChatComposerDraft(
      chatId,
      {
        text: "SENTINEL unfinished message",
        mode: "plan",
        reasoningEffort: "high",
      },
      options,
    );

    expect(JSON.stringify(state)).not.toContain("SENTINEL");
    await expect(
      openChatComposerDraft(
        chatId,
        {
          chatId,
          state,
          updatedAt: "2026-08-21T12:00:00.000Z",
        },
        options,
      ),
    ).resolves.toEqual({
      text: "SENTINEL unfinished message",
      mode: "plan",
      reasoningEffort: "high",
    });
  });

  it("round-trips attachment-only drafts with protected metadata", async () => {
    const attachment: ChatAttachmentSummary = {
      id: "attachment-one",
      chatId,
      fileName: "SENTINEL pasted-text.txt",
      mimeType: "text/plain",
      sizeBytes: 5166,
      kind: "text",
      source: "paste",
      status: "ready",
      previewText: "SENTINEL private attachment preview",
      createdAt: "2026-10-08T12:00:00.000Z",
    };
    const draft = {
      text: "",
      mode: "default" as const,
      reasoningEffort: null,
      attachments: [attachment],
    };
    const options = { service: readyService(), session };
    const state = await protectChatComposerDraft(chatId, draft, options);
    expect(JSON.stringify(state)).not.toContain("SENTINEL");
    expect(JSON.stringify(state)).not.toContain("attachment-one");
    await expect(
      openChatComposerDraft(
        chatId,
        { chatId, state, updatedAt: attachment.createdAt },
        options,
      ),
    ).resolves.toEqual(draft);
  });

  it("round-trips maximum text with twenty multilingual attachment previews", async () => {
    const options = { service: readyService(), session };
    const draft = {
      text: "界".repeat(100_000),
      mode: "default" as const,
      reasoningEffort: null,
      attachments: Array.from({ length: 20 }, (_, index) => ({
        id: `uploaded-${index}`,
        chatId,
        fileName: `private-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 24_000,
        kind: "text" as const,
        source: "file" as const,
        status: "ready" as const,
        previewText: "界".repeat(8_000),
        createdAt: "2026-10-08T12:00:00.000Z",
      })),
    };
    const state = await protectChatComposerDraft(chatId, draft, options);
    await expect(
      openChatComposerDraft(
        chatId,
        { chatId, state, updatedAt: null },
        options,
      ),
    ).resolves.toEqual(draft);
  });

  it("does not open a draft through another chat ID", async () => {
    const options = { service: readyService(), session };
    const state = await protectChatComposerDraft(
      chatId,
      { text: "private", mode: "default", reasoningEffort: null },
      options,
    );

    await expect(
      openChatComposerDraft(
        "chat-two",
        {
          chatId: "chat-two",
          state,
          updatedAt: "2026-08-21T12:00:00.000Z",
        },
        options,
      ),
    ).rejects.toThrow();
  });
});
