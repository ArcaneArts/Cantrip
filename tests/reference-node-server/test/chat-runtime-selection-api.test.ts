import { cantripOsExecutionSchema } from "@cantrip/protocol";
import { CantripOsPlacementError } from "../src/db/repository/cantrip-os.js";
import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";

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

const uuid = "12345678-1234-4234-8234-123456789abc";
const linux = cantripOsExecutionSchema.parse({
  kind: "cantrip-os",
  transport: { kind: "docker", container: "fixture" },
  scope: {
    ownerId: "owner-one",
    workerId: "worker-one",
    instanceId: uuid,
    guestInstanceId: uuid,
    attachmentGeneration: uuid,
    runtimeGeneration: uuid,
    bindingId: uuid,
    bindingGeneration: uuid,
    projectId: "project-one",
    projectSourceId: uuid,
    sourceKind: "folder",
    worktreeId: uuid,
    workspaceId: uuid,
    guestWorkspaceId: "fixture",
    uid: 20000,
    gid: 20000,
    homeGuestPath: "/home/fixture",
    guestPath: "/home/fixture/source",
    dependencyOverlays: [],
    mode: "linux-owned",
    linkedWorkerPath: null,
  },
});

const app = Fastify();
const opaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: Buffer.alloc(12).toString("base64url"),
    ciphertext: Buffer.alloc(16).toString("base64url"),
  },
};
const requestWorker = vi.fn(async () => ({
  operationId: "reference-operation",
  sequence: 0,
  protectedResponse: opaque,
}));

installChatBasicRoutes(app, {
  applicationOwnerId: () => "owner-one",
  bridge: {
    isConnected: () => false,
    request: requestWorker,
  },
  publishChatFilesChange: () => undefined,
  publishChatSummary: () => undefined,
  repository: {
    acknowledgeChatCompletion: async () => null,
    getChatComposerDraftWireState: async () => null,
    getChatExecutionContext: async (_ownerId, chatId) => {
      if (chatId === "stale-linux")
        throw new CantripOsPlacementError(
          "The captured Linux runtime changed.",
        );
      if (chatId === "chat-linux")
        return {
          ...context,
          chatId,
          contextKind: "project",
          projectId: "project-one",
          worktreeId: linux.scope.worktreeId,
          scratchRootId: null,
          osExecution: linux,
          cwd: linux.scope.guestPath,
        };
      return chatId === context.chatId
        ? context
        : chatId === "chat-project"
          ? {
              ...context,
              chatId,
              contextKind: "project",
              projectId: "project-one",
              worktreeId: "worktree-one",
              scratchRootId: null,
              cwd: "/srv/project",
            }
          : null;
    },
    getWorker: async () => null,
    updateChat: async () => null,
    updateChatComposerDraft: async () => null,
  },
  serverId: "server-one",
} satisfies ChatBasicRouteDependencies);

afterAll(async () => {
  await app.close();
});

describe("chat referenced path metadata routing", () => {
  it.each([context.chatId, "chat-project", "chat-linux"])(
    "routes a protected read to the owning worker for %s",
    async (chatId) => {
      requestWorker.mockClear();
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/file-references`,
        payload: {
          operationId: "reference-operation",
          sequence: 0,
          protectedRequest: opaque,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(requestWorker).toHaveBeenCalledExactlyOnceWith("worker-one", {
        type: "chat.files.references",
        chatId,
        serverId: "server-one",
        root:
          chatId === "chat-linux"
            ? linux
            : chatId === "chat-project"
              ? "/srv/project"
              : context.cwd,
        operationId: "reference-operation",
        sequence: 0,
        protectedRequest: opaque,
      });
      expect(response.json()).toEqual({
        operationId: "reference-operation",
        sequence: 0,
        protectedResponse: opaque,
      });
    },
  );

  it("reports stale Linux placement without dispatching any Host file read", async () => {
    requestWorker.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/chats/stale-linux/file-references",
      payload: {
        operationId: "reference-operation",
        sequence: 0,
        protectedRequest: opaque,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "The captured Linux runtime changed.",
    });
    expect(requestWorker).not.toHaveBeenCalled();
  });

  it("does not dispatch a reference read for an unknown chat", async () => {
    requestWorker.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/chats/missing/file-references",
      payload: {
        operationId: "reference-operation",
        sequence: 0,
        protectedRequest: opaque,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(requestWorker).not.toHaveBeenCalled();
  });
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
