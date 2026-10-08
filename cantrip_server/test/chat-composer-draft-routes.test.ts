import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { CHAT_COMPOSER_DRAFT_PROTECTED_CONTENT_BYTES_LIMIT } from "@cantrip/protocol/communication-content";
import {
  installChatBasicRoutes,
  type ChatBasicRouteDependencies,
} from "../src/app/routes/chat-basic-routes.js";

function fixture() {
  let state: unknown = null;
  const repository = {
    getChatComposerDraftWireState: vi.fn(
      async (ownerId: string, chatId: string) =>
        ownerId === "owner" && chatId === "chat"
          ? { chatId, state, updatedAt: null }
          : null,
    ),
    updateChatComposerDraft: vi.fn(
      async (ownerId: string, chatId: string, next: unknown) => {
        if (ownerId !== "owner" || chatId !== "chat") return null;
        state = next;
        return { chatId, state, updatedAt: null };
      },
    ),
  };
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  installChatBasicRoutes(app, {
    applicationOwnerId: () => "owner",
    bridge: { isConnected: () => false, request: vi.fn() },
    publishChatFilesChange: vi.fn(),
    publishChatSummary: vi.fn(),
    repository:
      repository as unknown as ChatBasicRouteDependencies["repository"],
    serverId: "server",
  });
  return { app, repository };
}

function opaqueState(ciphertextCharacters: number) {
  return {
    protectedContent: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "A".repeat(ciphertextCharacters),
      },
    },
  };
}

describe("encrypted composer draft routes", () => {
  it("saves and restores attachment-preview-sized encrypted drafts above the global body limit", async () => {
    const { app, repository } = fixture();
    try {
      const state = opaqueState(1_100_000);
      const saved = await app.inject({
        method: "PUT",
        url: "/api/chats/chat/composer-draft",
        payload: { state },
      });
      expect(saved.statusCode).toBe(200);
      expect(repository.updateChatComposerDraft).toHaveBeenCalledWith(
        "owner",
        "chat",
        state,
      );
      const restored = await app.inject({
        method: "GET",
        url: "/api/chats/chat/composer-draft",
      });
      expect(restored.json().state).toEqual(state);
      const cleared = await app.inject({
        method: "PUT",
        url: "/api/chats/chat/composer-draft",
        payload: { state: null },
      });
      expect(cleared.json().state).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects oversized drafts without writing them", async () => {
    const { app, repository } = fixture();
    try {
      const maximum = Math.ceil(
        ((CHAT_COMPOSER_DRAFT_PROTECTED_CONTENT_BYTES_LIMIT + 16) * 4) / 3,
      );
      const result = await app.inject({
        method: "PUT",
        url: "/api/chats/chat/composer-draft",
        payload: { state: opaqueState(maximum + 2_000) },
      });
      expect(result.statusCode).toBe(413);
      expect(repository.updateChatComposerDraft).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps missing or inaccessible chats inaccessible", async () => {
    const { app } = fixture();
    try {
      const result = await app.inject({
        method: "PUT",
        url: "/api/chats/another-chat/composer-draft",
        payload: { state: opaqueState(22) },
      });
      expect(result.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
