import {
  EMPTY_MODEL_CONFIGURATION,
  type WorkerCommand,
} from "@cantrip/protocol";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installChatRuntimeConfigurationRoutes } from "../src/app/routes/chat-runtime-configuration.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
} from "../src/db/repository.js";

const context: ChatExecutionContext = {
  automationPaused: false,
  chatId: "chat-one",
  contextKind: "project",
  cwd: "/workspace/project",
  defaultPermissionProfileId: ":workspace",
  executionLaneId: null,
  experience: "chat",
  isPrimary: false,
  modelConfiguration: {
    ...EMPTY_MODEL_CONFIGURATION,
    modelId: "model-one",
    reasoningEffort: "medium",
  },
  modelId: "model-one",
  modelRouteId: "route-one",
  permissionProfileId: null,
  planMode: "default",
  projectId: "project-one",
  providerAccountId: null,
  reasoningEffort: "medium",
  rootKind: "local",
  scratchRootId: null,
  status: "idle",
  threadId: "thread-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  worktreeMode: "pinned",
  worktreePolicy: "direct",
};

const runtime: ModelRuntime = {
  model: {
    catalog: null,
    id: "model-one",
    name: "gpt-6-astra",
    profileName: "Astra",
    providerModelId: null,
    reasoningEffort: "medium",
    routeId: "route-one",
  },
  provider: {
    accountId: null,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    credentialHomeKey: null,
    id: "provider-one",
    kind: "chatgpt",
    name: "ChatGPT",
    protectedApiKey: null,
    weeklyUsageReservePercent: 0,
  },
  routeId: "route-one",
};

describe("warmed chat runtime configuration", () => {
  it("applies a permission change to Codex before persisting it", async () => {
    const app = Fastify();
    const request = vi.fn(async (_workerId: string, command: WorkerCommand) => {
      if (command.type === "permission-profiles.list") {
        return {
          available: true,
          profiles: [
            { id: ":read-only", description: "Inspection only", allowed: true },
            { id: ":workspace", description: "Workspace", allowed: true },
          ],
          reason: null,
        };
      }
      if (command.type === "chat.thread.ensure") {
        return { threadId: command.threadId };
      }
      throw new Error(`Unexpected command ${command.type}`);
    });
    const setChatPermissionProfile = vi.fn(async () => ({ id: "chat-one" }));
    const updateChatRuntime = vi.fn(async () => undefined);
    installChatRuntimeConfigurationRoutes(app, {
      applicationOwnerId: () => "owner-one",
      availableModelRuntimes: async () => [runtime],
      bridge: { isConnected: () => true, request },
      reasoningStateForContext: async () => ({
        incompleteMetadata: false,
        modelId: "model-one",
        options: [],
        reasoningEffort: "medium",
        reasoningMandatory: false,
      }),
      repository: {
        getChatExecutionContext: async () => ({
          ...context,
          permissionProfileId:
            setChatPermissionProfile.mock.calls.length > 0
              ? ":read-only"
              : null,
        }),
        getModelReasoningDefault: async () => null,
        listEffectiveMcpServers: async () => [],
        setChatModelConfiguration: async () => null,
        setChatPermissionProfile,
        updateChatRuntime,
      },
      resolveModelId: async () => "model-one",
      routePairsForConfiguration: async () => [
        {
          root: {
            adjusted: false,
            appliedReasoningEffort: "medium",
            runtime,
          },
          subagent: null,
        },
      ],
      runtimeForContext: async () => runtime,
      sendModelConfigurationResolutionFailure: () => null,
    });

    const response = await app.inject({
      method: "PATCH",
      payload: { id: ":read-only" },
      url: "/api/chats/chat-one/permission-profile",
    });

    expect(response.statusCode).toBe(200);
    expect(
      request.mock.calls.map(([, command]) => command).at(-1),
    ).toMatchObject({
      permissionProfileId: ":read-only",
      threadId: "thread-one",
      type: "chat.thread.ensure",
    });
    expect(updateChatRuntime).toHaveBeenCalledWith(
      "chat-one",
      "worker-one",
      "worktree-one",
      "thread-one",
      "route-one",
      "ready",
      null,
      null,
    );
    expect(updateChatRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      setChatPermissionProfile.mock.invocationCallOrder[0]!,
    );
    await app.close();
  });
});
