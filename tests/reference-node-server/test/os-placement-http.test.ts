import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { installApplicationErrorHandler } from "../src/app/http/error-handler.js";
import { installChatSyncAndMessageReadRoutes } from "../src/app/routes/chat-messages-and-sync.js";
import { CantripOsPlacementError } from "../src/db/repository/cantrip-os-error.js";

it("reports a changed Linux source as an HTTP conflict before thread reconciliation or Worker dispatch", async () => {
  const app = Fastify();
  const clear = vi.fn();
  installApplicationErrorHandler(app, { clear } as Parameters<
    typeof installApplicationErrorHandler
  >[1]);
  const request = vi.fn(),
    reconcileChatThread = vi.fn(),
    runtimeForContext = vi.fn();
  const context = vi.fn(async () => {
    throw new CantripOsPlacementError(
      "The captured Linux runtime changed; no Host fallback was attempted.",
    );
  });
  installChatSyncAndMessageReadRoutes(app, {
    applicationOwnerId: () => "owner",
    bridge: { request, isConnected: () => true },
    reconcileChatThread,
    runtimeForContext,
    repository: { getChatExecutionContext: context },
  } as Parameters<typeof installChatSyncAndMessageReadRoutes>[1]);
  try {
    const result = await app.inject({
      method: "POST",
      url: "/api/chats/linux-chat/sync",
    });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toEqual({
      error:
        "The captured Linux runtime changed; no Host fallback was attempted.",
    });
    expect(context).toHaveBeenCalledWith("owner", "linux-chat");
    expect(reconcileChatThread).not.toHaveBeenCalled();
    expect(runtimeForContext).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
