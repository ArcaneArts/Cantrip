import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import type { ChatExecutionContext } from "../src/db/repository.js";
import {
  installChatBasicRoutes,
  type ChatBasicRouteDependencies,
} from "../src/app/routes/chat-basic-routes.js";

const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat-one",
  contextKind: "standalone",
  cwd: "/tmp/chat-one",
  defaultPermissionProfileId: "default",
  executionLaneId: null,
  experience: "agent",
  isPrimary: true,
  modelConfiguration: {
    customSubagentModel: false,
    modelId: "model-one",
    reasoningEffort: null,
    subagentModelId: null,
    subagentReasoningEffort: null,
  },
  modelId: "model-one",
  modelRouteId: "route-two",
  permissionProfileId: null,
  planMode: "default",
  projectId: null,
  providerAccountId: "account-two",
  reasoningEffort: null,
  rootKind: null,
  scratchRootStatus: "ready",
  scratchRootId: "scratch-one",
  status: "idle",
  threadId: "thread-one",
  workerId: "worker-one",
  worktreeId: null,
  worktreeMode: null,
  worktreePolicy: null,
};

const app = Fastify();

installChatBasicRoutes(app, {
  applicationOwnerId: () => "owner-one",
  bridge: {
    isConnected: () => false,
    request: async () => {
      throw new Error("Worker requests are not expected in this test.");
    },
  },
  publishChatFilesChange: () => undefined,
  publishChatSummary: () => undefined,
  repository: {
    acknowledgeChatCompletion: async () => null,
    getChatComposerDraftWireState: async () => null,
    getChatExecutionContext: async (_ownerId, chatId) =>
      chatId === context.chatId ? context : null,
    getWorker: async () => null,
    updateChat: async () => null,
    updateChatComposerDraft: async () => null,
  },
  serverId: "server-one",
} satisfies ChatBasicRouteDependencies);

afterAll(async () => {
  await app.close();
});

describe("chat runtime selection API", () => {
  it("returns the route and account selected by the active runtime", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/chats/chat-one/runtime-selection",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      modelRouteId: "route-two",
      providerAccountId: "account-two",
    });
  });

  it("does not expose runtime selection for an unknown chat", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/chats/missing/runtime-selection",
    });

    expect(response.statusCode, response.body).toBe(404);
  });
});
