import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { chatWireSummarySchema } from "@cantrip/protocol";
import {
  installChatForkRoute,
  type ChatForkRouteDependencies,
} from "../src/app/routes/chat-forks.js";
import { protectedChatFields } from "./private-label-fixture.js";

it("publishes the committed project fork so other conversation catalogs refresh", async () => {
  const input = { ...protectedChatFields(), attachToTabLayout: false };
  const chat = chatWireSummarySchema.parse({
    id: input.id,
    titleProtection: input.titleProtection,
    projectId: "project",
    contextKind: "project",
    experience: "agent",
    position: 0,
    status: "idle",
    activeWorkerId: "worker",
    activeWorktreeId: "tree",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: false,
    automationPaused: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const publish = vi.fn();
  const fork = vi.fn(async (): Promise<typeof chat | null> => chat);
  const app = Fastify();
  installChatForkRoute(app, {
    applicationOwnerId: () => "owner",
    bridge: { isConnected: () => true, request: vi.fn() },
    repository: {
      getChatExecutionContext: async () => ({
        contextKind: "project",
        experience: "agent",
        workerId: "worker",
      }),
      forkChat: fork,
      forkStandaloneChat: vi.fn(),
    },
    publishChatSummary: publish,
    queueStandaloneChatRootJobs: vi.fn(),
  } as unknown as ChatForkRouteDependencies);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/chats/source/fork",
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    expect(publish).toHaveBeenCalledExactlyOnceWith(chat.id, "project");
    fork.mockResolvedValueOnce(null);
    const missing = await app.inject({
      method: "POST",
      url: "/api/chats/missing/fork",
      payload: input,
    });
    expect(missing.statusCode).toBe(404);
    expect(publish).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
