import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { installMutationLiveInvalidationHook } from "../src/app/http/mutation-live-invalidation.js";
import { installChatNativeHistoryTurnRoutes } from "../src/app/routes/chat-native-history-turns.js";

it("does not announce a chat mutation after the real native-history read route", async () => {
  const app = Fastify();
  const publishLiveInvalidation = vi.fn();
  const publishChatInvalidation = vi.fn();
  const readForChat = vi.fn(async () => ({ turns: [] }));
  installMutationLiveInvalidationHook(app, {
    publishLiveInvalidation,
    publishChatInvalidation,
  });
  installChatNativeHistoryTurnRoutes(app, {
    applicationOwnerId: () => "owner",
    repository: { nativeHistoryArchive: { readForChat } } as never,
  });
  app.post("/api/chats/:chatId/messages", async () => ({ accepted: true }));
  try {
    const result = await app.inject({
      method: "POST",
      url: "/api/chats/chat/native-history/turns/read",
      payload: { turns: [{ threadId: "thread", turnId: "turn" }] },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(readForChat).toHaveBeenCalledTimes(1);
    expect(publishLiveInvalidation).not.toHaveBeenCalled();
    expect(publishChatInvalidation).not.toHaveBeenCalled();
    await app.inject({
      method: "POST",
      url: "/api/chats/chat/messages",
      payload: {},
    });
    expect(publishLiveInvalidation).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ entityId: "chat" }),
    );
  } finally {
    await app.close();
  }
});
