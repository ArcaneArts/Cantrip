import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { CantripOsPlacementError } from "../src/db/repository/cantrip-os.js";
import {
  installChatSyncAndMessageReadRoutes,
  type ChatSyncAndMessageReadRouteDependencies,
} from "../src/app/routes/chat-messages-and-sync.js";
import {
  installChatQueueRoutes,
  type ChatQueueRouteDependencies,
} from "../src/app/routes/chat-queue.js";
import {
  installChatPlanRoutes,
  type ChatPlanRouteDependencies,
} from "../src/app/routes/chat-plan.js";

it("reads owned stored messages, queue and plan while the captured Linux epoch is stale", async () => {
  const app = Fastify();
  const execute = vi.fn(async () => {
    throw new CantripOsPlacementError("The captured Linux runtime changed.");
  });
  const bridge = { isConnected: vi.fn(() => true), request: vi.fn() };
  const snapshot = { revision: 3, items: [], pendingImports: [], claims: [] };
  const state = {
    kind: "chat-encrypted",
    chatId: "chat",
    mode: "default",
    hasQuestion: false,
    state: null,
  };
  const repository = {
    getChatExecutionContext: execute,
    getChatLiveRouting: vi.fn(async (_owner: string, chat: string) =>
      chat === "chat" ? { experience: "agent", projectId: "project" } : null,
    ),
    listEncryptedMessages: vi.fn(async () => []),
    listEncryptedMessagePage: vi.fn(async () => ({
      messages: [],
      page: { hasMore: false, nextBeforeSequence: null },
    })),
    managedQueue: { snapshot: vi.fn(async () => snapshot) },
    listEncryptedQueuedPrompts: vi.fn(async () => []),
    getChatPlanWireState: vi.fn(async () => state),
  };
  installChatSyncAndMessageReadRoutes(app, {
    applicationOwnerId: () => "owner",
    bridge,
    repository,
  } as unknown as ChatSyncAndMessageReadRouteDependencies);
  installChatQueueRoutes(app, {
    applicationOwnerId: () => "owner",
    bridge,
    repository,
  } as unknown as ChatQueueRouteDependencies);
  installChatPlanRoutes(app, {
    applicationOwnerId: () => "owner",
    bridge,
    repository,
  } as unknown as ChatPlanRouteDependencies);
  try {
    const messages = await app.inject({
      method: "GET",
      url: "/api/chats/chat/messages",
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual({ kind: "chat-encrypted", messages: [] });
    const queue = await app.inject({
      method: "GET",
      url: "/api/chats/chat/queue",
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toEqual(snapshot);
    expect(execute).not.toHaveBeenCalled();
    const plan = await app.inject({
      method: "GET",
      url: "/api/chats/chat/plan",
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toEqual(state);
    expect(bridge.request).not.toHaveBeenCalled();
    const missing = await app.inject({
      method: "GET",
      url: "/api/chats/foreign/messages",
    });
    expect(missing.statusCode).toBe(404);
    expect(repository.listEncryptedMessages).toHaveBeenCalledTimes(1);
    // Execution still uses the original capture and rejects the changed epoch.
    const sync = await app.inject({
      method: "POST",
      url: "/api/chats/chat/sync",
    });
    // This isolated router has no application error mapper; execution still fails.
    expect(sync.statusCode).toBe(500);
    expect(bridge.request).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
