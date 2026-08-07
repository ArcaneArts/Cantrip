import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chatListSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatSummarySchema,
  gitHistorySchema,
  modelProfileSummarySchema,
  modelProviderSummarySchema,
  projectListSchema,
  projectSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  terminalListSchema,
  terminalSummarySchema,
  workerListSchema,
} from "@cantrip/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-local-foundation-"),
);

const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

let turnRequests = 0;
const turnModelIds: string[] = [];
const turnPrompts: string[] = [];
const deletedProjectPaths: string[] = [];
const workerBridge = {
  attach() {},
  close() {},
  isConnected(workerId: string) {
    return workerId === "test-worker";
  },
  async request(_workerId, command, options) {
    switch (command.type) {
      case "codex.auth.status":
        return {
          authenticated: true,
          authMode: "chatgpt",
          email: "test@example.com",
          planType: "plus",
          weeklyUsage: { usedPercent: 37, resetsAt: 1_786_665_600 },
        };
      case "codex.auth.login.start":
        return {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "TEST-CODE",
        };
      case "codex.auth.logout":
        return { accepted: true };
      case "github.auth.status":
        return { authenticated: true, login: "cantrip-test", source: "gh-cli" };
      case "github.repositories.list":
        return [
          {
            id: "github-repository-1",
            name: "Cantrip",
            nameWithOwner: "ArcaneArts/Cantrip",
            description: "Test repository",
            isPrivate: true,
            isFork: false,
            url: "https://github.com/ArcaneArts/Cantrip",
            defaultBranch: "main",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ];
      case "project.clone":
        return {
          path: path.join(dataDirectory, "repositories", "Cantrip"),
          displayPath: "ArcaneArts/Cantrip",
          reused: false,
          updated: false,
          warning: null,
        };
      case "project.files.delete":
        deletedProjectPaths.push(command.path);
        return { deleted: true };
      case "git.history":
        return {
          branch: "main",
          head: "0123456789abcdef",
          commits: [
            {
              hash: "0123456789abcdef",
              shortHash: "0123456",
              parents: [],
              subject: "feat: test history",
              authorName: "Cantrip Test",
              authorEmail: "test@cantrip.art",
              authoredAt: "2026-08-07T12:00:00.000Z",
              refs: [
                { name: "HEAD", kind: "head", current: true },
                { name: "main", kind: "local", current: true },
              ],
              isHead: true,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      case "terminal.open":
        return { status: "detached" };
      case "terminal.detach":
      case "terminal.input":
      case "terminal.resize":
      case "terminal.close":
        return { accepted: true };
      case "chat.turn":
        turnRequests += 1;
        turnModelIds.push(command.model.id);
        turnPrompts.push(command.prompt);
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "running",
            exitCode: null,
            output: null,
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "command",
            id: "command-1",
            command: "pwd",
            cwd: ".",
            status: "completed",
            exitCode: 0,
            output: "/worktree\n",
          },
        });
        await options?.onEvent?.({
          type: "agent.activity",
          activity: {
            type: "fileChange",
            id: "file-change-1",
            status: "completed",
            changes: [{ path: "README.md", kind: "update" }],
          },
        });
        return {
          threadId: command.threadId ?? "codex-thread-1",
          text: "The local agent replied.",
          status: "completed",
        };
    }
  },
} satisfies WorkerCommandBus;

afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("local server foundation", () => {
  it("persists server configuration, workers, and conversations", async () => {
    const firstDatabase = await connectDatabase(config);
    const firstApp = await buildApp({
      config,
      database: firstDatabase,
      logger: false,
      workerBridge,
    });

    const bootstrap = serverBootstrapSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/bootstrap" })).json(),
    );
    expect(bootstrap.auth).toMatchObject({
      mode: "none",
      currentUser: { kind: "anonymous" },
    });
    expect(bootstrap.routing.directWorkerConnections).toBe(false);

    const initialSettings = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(initialSettings.preferences).toMatchObject({
      theme: "system",
      defaultModelId: expect.any(String),
    });
    const provider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            name: "Test provider",
            kind: "openai-compatible",
            baseUrl: "https://models.example.test/v1",
            apiKey: "server-only-secret",
          },
        })
      ).json(),
    );
    expect(provider.hasApiKey).toBe(true);
    const editedProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/providers/${provider.id}`,
          payload: {
            name: "Edited test provider",
            kind: "openai-compatible",
            baseUrl: "https://edited-models.example.test/v1/",
          },
        })
      ).json(),
    );
    expect(editedProvider).toMatchObject({
      name: "Edited test provider",
      baseUrl: "https://edited-models.example.test/v1",
      hasApiKey: true,
    });
    const selectedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/models",
          payload: {
            name: "test-model",
            providerId: provider.id,
            reasoningEffort: "high",
          },
        })
      ).json(),
    );
    const editedModel = modelProfileSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/settings/models/${selectedModel.id}`,
          payload: {
            name: "edited-test-model",
            providerId: provider.id,
            reasoningEffort: "medium",
          },
        })
      ).json(),
    );
    expect(editedModel).toMatchObject({
      name: "edited-test-model",
      providerName: "Edited test provider",
      reasoningEffort: "medium",
    });
    const updatedSettings = settingsBundleSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { theme: "dark", defaultModelId: selectedModel.id },
        })
      ).json(),
    );
    expect(updatedSettings.preferences).toEqual({
      theme: "dark",
      defaultModelId: selectedModel.id,
    });

    const heartbeatResponse = await firstApp.inject({
      method: "POST",
      url: "/api/internal/workers/heartbeat",
      headers: { authorization: "Bearer test-worker-token" },
      payload: {
        workerId: "test-worker",
        name: "Test Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "codex-cli 1.0.0",
        startedAt: "2026-08-07T12:00:00.000Z",
      },
    });
    expect(heartbeatResponse.statusCode).toBe(202);
    expect(
      (
        await firstApp.inject({
          method: "GET",
          url: "/api/codex/auth/status?workerId=test-worker",
        })
      ).json(),
    ).toMatchObject({
      authMode: "chatgpt",
      planType: "plus",
      weeklyUsage: { usedPercent: 37 },
    });
    const settingsAfterCodexLogin = settingsBundleSchema.parse(
      (await firstApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    expect(
      settingsAfterCodexLogin.providers.filter(
        (provider) => provider.kind === "chatgpt",
      ),
    ).toMatchObject([{ name: "ChatGPT", hasApiKey: false }]);
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/codex/auth/device-login",
          payload: { workerId: "test-worker" },
        })
      ).json(),
    ).toMatchObject({ userCode: "TEST-CODE" });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/codex/auth/logout",
        payload: { workerId: "test-worker" },
      }),
    ).toMatchObject({ statusCode: 204 });

    const projectResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    const project = projectSummarySchema.parse(projectResponse.json());
    const history = gitHistorySchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/history`,
        })
      ).json(),
    );
    expect(history).toMatchObject({
      branch: "main",
      commits: [{ subject: "feat: test history" }],
    });
    const terminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: { title: "Dev shell" },
        })
      ).json(),
    );
    expect(terminal).toMatchObject({
      projectId: project.id,
      title: "Dev shell",
      activeWorkerId: "test-worker",
    });
    expect(
      terminalListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/terminals/${terminal.id}`,
            payload: { title: "Renamed shell" },
          })
        ).json(),
      ).title,
    ).toBe("Renamed shell");
    expect(
      (
        await firstApp.inject({
          method: "DELETE",
          url: `/api/terminals/${terminal.id}`,
        })
      ).statusCode,
    ).toBe(204);

    const duplicateResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects/from-github",
      payload: {
        workerId: "test-worker",
        repositoryId: "github-repository-1",
        nameWithOwner: "ArcaneArts/Cantrip",
        url: "https://github.com/ArcaneArts/Cantrip",
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const chatResponse = await firstApp.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: { title: "Foundation" },
    });
    const chat = chatSummarySchema.parse(chatResponse.json());
    const selectedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}/model`,
          payload: { modelId: selectedModel.id },
        })
      ).json(),
    );
    expect(selectedChat).toMatchObject({
      modelId: selectedModel.id,
    });

    const messagePayload = {
      text: "Persist this message.",
      idempotencyKey: "first-message",
    };
    const firstMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    const repeatedMessage = chatMessageSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/turns`,
          payload: messagePayload,
        })
      ).json().message,
    );
    expect(repeatedMessage.id).toBe(firstMessage.id);
    await vi.waitFor(async () => {
      const messages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${chat.id}/messages`,
          })
        ).json(),
      );
      expect(messages).toHaveLength(4);
    });
    expect(turnRequests).toBe(1);
    expect(turnModelIds).toContain(selectedModel.id);
    const completedMessages = chatMessageListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    const renamedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/chats/${chat.id}`,
          payload: { title: "Renamed foundation" },
        })
      ).json(),
    );
    expect(renamedChat.title).toBe("Renamed foundation");
    const forkedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {
            messageId: completedMessages.at(-1)?.id,
          },
        })
      ).json(),
    );
    const duplicatedChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/fork`,
          payload: {},
        })
      ).json(),
    );
    expect(
      chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      ),
    ).toHaveLength(completedMessages.length);
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${forkedChat.id}/turns`,
        payload: {
          text: "Continue from the fork.",
          idempotencyKey: "fork-follow-up",
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnPrompts).toHaveLength(2));
    expect(turnPrompts[1]).toContain(
      "Continue this existing Cantrip conversation",
    );
    expect(turnPrompts[1]).toContain("The local agent replied.");
    await vi.waitFor(async () => {
      const forkMessages = chatMessageListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${forkedChat.id}/messages`,
          })
        ).json(),
      );
      expect(forkMessages).toHaveLength(completedMessages.length + 4);
    });
    const reorderedTerminal = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/terminals`,
          payload: { title: "Sortable shell" },
        })
      ).json(),
    );
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tabs/order`,
        payload: {
          ids: [
            `chat:${duplicatedChat.id}`,
            `terminal:${reorderedTerminal.id}`,
            `chat:${forkedChat.id}`,
            `chat:${chat.id}`,
          ],
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    const reorderedChats = chatListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/chats`,
        })
      ).json(),
    );
    expect(
      reorderedChats.map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: duplicatedChat.id, position: 0 },
      { id: forkedChat.id, position: 2 },
      { id: chat.id, position: 3 },
    ]);
    expect(
      terminalListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/terminals`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: reorderedTerminal.id, position: 1 }]);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/chats/${duplicatedChat.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: "/api/projects/order",
        payload: { ids: [project.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const changedModelResponse = await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}/model`,
      payload: { modelId: initialSettings.preferences.defaultModelId },
    });
    expect(changedModelResponse.statusCode).toBe(200);
    expect(chatSummarySchema.parse(changedModelResponse.json()).modelId).toBe(
      initialSettings.preferences.defaultModelId,
    );
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/turns`,
        payload: {
          text: "Use the newly selected model.",
          idempotencyKey: "dynamic-model-turn",
          modelId: initialSettings.preferences.defaultModelId,
        },
      }),
    ).toMatchObject({ statusCode: 202 });
    await vi.waitFor(() => expect(turnModelIds).toHaveLength(3));
    expect(turnModelIds.at(-1)).toBe(
      initialSettings.preferences.defaultModelId,
    );

    await firstApp.close();

    const secondDatabase = await connectDatabase(config);
    const secondApp = await buildApp({
      config,
      database: secondDatabase,
      logger: false,
      workerBridge,
    });

    const projects = projectListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/projects" })).json(),
    );
    const workers = workerListSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/workers" })).json(),
    );
    const restoredSettings = settingsBundleSchema.parse(
      (await secondApp.inject({ method: "GET", url: "/api/settings" })).json(),
    );
    const messages = chatMessageListSchema.parse(
      (
        await secondApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );

    expect(projects).toHaveLength(1);
    expect(workers).toHaveLength(1);
    expect(messages.slice(0, 4)).toMatchObject([
      firstMessage,
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "command",
              status: "completed",
              command: "pwd",
              output: "/worktree\n",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "activity",
            activity: {
              type: "fileChange",
              status: "completed",
              changes: [{ path: "README.md", kind: "update" }],
            },
          },
        ],
      },
      { role: "assistant", content: [{ text: "The local agent replied." }] },
    ]);
    expect(restoredSettings.preferences).toEqual({
      theme: "dark",
      defaultModelId: selectedModel.id,
    });

    const unlinkResponse = await secondApp.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: false },
    });
    expect(unlinkResponse.statusCode).toBe(204);
    expect(deletedProjectPaths).toEqual([]);
    expect(
      projectListSchema.parse(
        (
          await secondApp.inject({ method: "GET", url: "/api/projects" })
        ).json(),
      ),
    ).toEqual([]);

    const relinked = projectSummarySchema.parse(
      (
        await secondApp.inject({
          method: "POST",
          url: "/api/projects/from-github",
          payload: {
            workerId: "test-worker",
            repositoryId: "github-repository-1",
            nameWithOwner: "ArcaneArts/Cantrip",
            url: "https://github.com/ArcaneArts/Cantrip",
          },
        })
      ).json(),
    );
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/projects/${relinked.id}`,
        payload: { deleteLocalFiles: true },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(deletedProjectPaths).toEqual([
      path.join(dataDirectory, "repositories", "Cantrip"),
    ]);

    await secondApp.close();
  });
});
