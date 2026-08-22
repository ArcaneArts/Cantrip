import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

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
