import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentThreadSyncSchema,
  browserListSchema,
  browserSummarySchema,
  chatListSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatSummarySchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  gitActionResultSchema,
  gitHistorySchema,
  gitStatusSchema,
  modelProfileSummarySchema,
  modelProviderSummarySchema,
  projectListSchema,
  projectSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
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
let compactRequests = 0;
const turnModelIds: string[] = [];
const turnPrompts: string[] = [];
const deletedProjectPaths: string[] = [];
const authProviderIds: string[] = [];
const steeredPrompts: string[] = [];
let releaseHeldTurn: (() => void) | null = null;
const workerBridge = {
  attach() {},
  close() {},
  isConnected(workerId: string) {
    return workerId === "test-worker";
  },
  async request(_workerId, command, options) {
    switch (command.type) {
      case "codex.auth.status":
        authProviderIds.push(command.providerId);
        return {
          authenticated: true,
          authMode: "chatgpt",
          email: "test@example.com",
          planType: "plus",
          weeklyUsage: { usedPercent: 37, resetsAt: 1_786_665_600 },
        };
      case "codex.auth.login.start":
        authProviderIds.push(command.providerId);
        return {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "TEST-CODE",
        };
      case "codex.auth.logout":
        authProviderIds.push(command.providerId);
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
      case "git.status":
        return {
          branch: "main",
          head: "0123456789abcdef",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          files: [
            {
              path: "README.md",
              originalPath: null,
              indexStatus: " ",
              worktreeStatus: "M",
              staged: false,
              unstaged: true,
            },
          ],
          branches: [
            {
              name: "main",
              kind: "local",
              current: true,
              hash: "0123456789abcdef",
              upstream: "origin/main",
            },
          ],
        };
      case "git.action":
        return {
          status: {
            branch:
              command.action.type === "createBranch"
                ? command.action.name
                : "main",
            head: "0123456789abcdef",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [],
            branches: [
              {
                name: "main",
                kind: "local",
                current: command.action.type !== "createBranch",
                hash: "0123456789abcdef",
                upstream: "origin/main",
              },
            ],
          },
          output: "Git action complete",
        };
      case "explorer.directory.list":
        return {
          path: command.path,
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              size: 18,
              modifiedAt: "2026-08-07T12:00:00.000Z",
              viewable: true,
              markdown: true,
            },
          ],
          truncated: false,
        };
      case "explorer.file.read":
        return {
          path: command.path,
          content: "# Cantrip explorer\n",
          size: 18,
          markdown: true,
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
        if (command.prompt.includes("Hold queue open.")) {
          await new Promise<void>((resolve) => {
            releaseHeldTurn = resolve;
          });
        }
        return {
          threadId: command.threadId ?? "codex-thread-1",
          text: "The local agent replied.",
          status: "completed",
        };
      case "chat.compact":
        compactRequests += 1;
        return { accepted: true };
      case "chat.interrupt":
        return { interrupted: false };
      case "chat.steer":
        steeredPrompts.push(command.prompt);
        return { steered: true, turnId: "turn-held" };
      case "chat.sync":
        return {
          threadId: command.threadId,
          status: "idle",
          turns: [
            {
              id: "console-turn-1",
              status: "completed",
              startedAt: 1_786_134_300,
              completedAt: 1_786_134_302,
              durationMs: 2_000,
              items: [
                {
                  type: "userMessage",
                  id: "console-user-1",
                  text: "What is 4+4?",
                },
                {
                  type: "agentMessage",
                  id: "console-agent-1",
                  text: "8",
                  phase: null,
                },
              ],
            },
          ],
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
      highContrast: false,
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
          payload: {
            theme: "dark",
            highContrast: true,
            defaultModelId: selectedModel.id,
          },
        })
      ).json(),
    );
    expect(updatedSettings.preferences).toEqual({
      theme: "dark",
      highContrast: true,
      defaultModelId: selectedModel.id,
    });
    const chatGptProvider = modelProviderSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/settings/providers",
          payload: {
            name: "Personal ChatGPT",
            kind: "chatgpt",
            baseUrl: "https://api.openai.com/v1",
          },
        })
      ).json(),
    );

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
          url: `/api/codex/auth/status?workerId=test-worker&providerId=${chatGptProvider.id}`,
        })
      ).json(),
    ).toMatchObject({
      authMode: "chatgpt",
      planType: "plus",
      weeklyUsage: { usedPercent: 37 },
    });
    expect(
      (
        await firstApp.inject({
          method: "POST",
          url: "/api/codex/auth/device-login",
          payload: {
            workerId: "test-worker",
            providerId: chatGptProvider.id,
          },
        })
      ).json(),
    ).toMatchObject({ userCode: "TEST-CODE" });
    expect(
      await firstApp.inject({
        method: "POST",
        url: "/api/codex/auth/logout",
        payload: {
          workerId: "test-worker",
          providerId: chatGptProvider.id,
        },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(authProviderIds).toEqual([
      chatGptProvider.id,
      chatGptProvider.id,
      chatGptProvider.id,
    ]);

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
    const gitStatus = gitStatusSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/projects/${project.id}/git/status`,
        })
      ).json(),
    );
    expect(gitStatus).toMatchObject({
      branch: "main",
      ahead: 1,
      files: [{ path: "README.md", unstaged: true }],
    });
    const gitAction = gitActionResultSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/git/actions`,
          payload: { type: "stageAll" },
        })
      ).json(),
    );
    expect(gitAction).toMatchObject({
      output: "Git action complete",
      status: { files: [] },
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
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/compact`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(compactRequests).toBe(1);
    const firstSync = agentThreadSyncSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/sync`,
        })
      ).json(),
    );
    expect(firstSync.turns).toHaveLength(1);
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/sync`,
    });
    const completedMessages = chatMessageListSchema.parse(
      (
        await firstApp.inject({
          method: "GET",
          url: `/api/chats/${chat.id}/messages`,
        })
      ).json(),
    );
    expect(completedMessages.slice(-2)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "What is 4+4?" }] },
      { role: "assistant", content: [{ type: "text", text: "8" }] },
    ]);
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
    const explorer = explorerSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/explorers`,
          payload: { title: "Project files" },
        })
      ).json(),
    );
    expect(
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toHaveLength(1);
    expect(
      explorerDirectorySchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/directory?path=`,
          })
        ).json(),
      ).entries[0],
    ).toMatchObject({ name: "README.md", markdown: true });
    expect(
      explorerFileSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/explorers/${explorer.id}/file?path=README.md`,
          })
        ).json(),
      ).content,
    ).toContain("Cantrip explorer");
    expect(
      explorerSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/explorers/${explorer.id}`,
            payload: { title: "Source browser" },
          })
        ).json(),
      ).title,
    ).toBe("Source browser");
    const browser = browserSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/browsers`,
          payload: { title: "Project web" },
        })
      ).json(),
    );
    expect(
      browserSummarySchema.parse(
        (
          await firstApp.inject({
            method: "PATCH",
            url: `/api/browsers/${browser.id}`,
            payload: { title: "Docs", url: "https://example.com/docs" },
          })
        ).json(),
      ),
    ).toMatchObject({ title: "Docs", url: "https://example.com/docs" });
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/tabs/order`,
        payload: {
          ids: [
            `chat:${duplicatedChat.id}`,
            `terminal:${reorderedTerminal.id}`,
            `browser:${browser.id}`,
            `explorer:${explorer.id}`,
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
      { id: forkedChat.id, position: 4 },
      { id: chat.id, position: 5 },
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
      explorerListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: explorer.id, position: 3 }]);
    expect(
      browserListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: browser.id, position: 2 }]);
    const linkedConsole = terminalSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${chat.id}/console`,
        })
      ).json(),
    );
    expect(linkedConsole).toMatchObject({
      linkedChatId: chat.id,
      projectId: project.id,
      title: "Codex console",
    });
    expect(
      terminalSummarySchema.parse(
        (
          await firstApp.inject({
            method: "POST",
            url: `/api/chats/${chat.id}/console`,
          })
        ).json(),
      ).id,
    ).toBe(linkedConsole.id);
    expect(
      await firstApp.inject({
        method: "DELETE",
        url: `/api/terminals/${linkedConsole.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
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

    const queueChat = chatSummarySchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/projects/${project.id}/chats`,
          payload: { title: "Prompt queue" },
        })
      ).json(),
    );
    await firstApp.inject({
      method: "PATCH",
      url: `/api/chats/${queueChat.id}/model`,
      payload: { modelId: selectedModel.id },
    });
    await firstApp.inject({
      method: "POST",
      url: `/api/chats/${queueChat.id}/turns`,
      payload: { text: "Hold queue open.", idempotencyKey: "queue-running" },
    });
    await vi.waitFor(() => expect(releaseHeldTurn).not.toBeNull());

    const firstQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: { text: "First follow-up", idempotencyKey: "queued-first" },
        })
      ).json().prompt,
    );
    const secondQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "POST",
          url: `/api/chats/${queueChat.id}/turns`,
          payload: {
            text: "Second follow-up",
            idempotencyKey: "queued-second",
          },
        })
      ).json().prompt,
    );
    expect(
      queuedPromptListSchema
        .parse(
          (
            await firstApp.inject({
              method: "GET",
              url: `/api/chats/${queueChat.id}/queue`,
            })
          ).json(),
        )
        .map(({ id }) => id),
    ).toEqual([firstQueued.id, secondQueued.id]);
    expect(
      await firstApp.inject({
        method: "PATCH",
        url: `/api/chats/${queueChat.id}/queue/order`,
        payload: { ids: [secondQueued.id, firstQueued.id] },
      }),
    ).toMatchObject({ statusCode: 204 });
    const editedQueued = queuedPromptSchema.parse(
      (
        await firstApp.inject({
          method: "PATCH",
          url: `/api/queued-prompts/${secondQueued.id}`,
          payload: { text: "Edited second follow-up", frozen: true },
        })
      ).json(),
    );
    expect(editedQueued).toMatchObject({
      id: secondQueued.id,
      position: 0,
      frozen: true,
      text: "Edited second follow-up",
    });
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${firstQueued.id}`,
      payload: { frozen: true },
    });
    expect(
      await firstApp.inject({
        method: "POST",
        url: `/api/queued-prompts/${firstQueued.id}/steer`,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(steeredPrompts).toContain("First follow-up");

    const turnsBeforeRelease = turnRequests;
    releaseHeldTurn?.();
    releaseHeldTurn = null;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turnRequests).toBe(turnsBeforeRelease);
    await firstApp.inject({
      method: "PATCH",
      url: `/api/queued-prompts/${secondQueued.id}`,
      payload: { frozen: false },
    });
    await vi.waitFor(() =>
      expect(turnPrompts).toContain("Edited second follow-up"),
    );
    await vi.waitFor(async () => {
      const remaining = queuedPromptListSchema.parse(
        (
          await firstApp.inject({
            method: "GET",
            url: `/api/chats/${queueChat.id}/queue`,
          })
        ).json(),
      );
      expect(remaining).toHaveLength(0);
    });

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
      highContrast: true,
      defaultModelId: selectedModel.id,
    });
    expect(
      explorerListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/explorers`,
          })
        ).json(),
      ),
    ).toMatchObject([{ id: explorer.id, title: "Source browser" }]);
    expect(
      browserListSchema.parse(
        (
          await secondApp.inject({
            method: "GET",
            url: `/api/projects/${project.id}/browsers`,
          })
        ).json(),
      ),
    ).toMatchObject([
      { id: browser.id, title: "Docs", url: "https://example.com/docs" },
    ]);
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/browsers/${browser.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await secondApp.inject({
        method: "DELETE",
        url: `/api/explorers/${explorer.id}`,
      }),
    ).toMatchObject({ statusCode: 204 });

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
