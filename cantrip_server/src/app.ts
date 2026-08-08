import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentThreadSyncSchema,
  agentTurnResultSchema,
  browserCreateSchema,
  browserListSchema,
  browserSummarySchema,
  browserUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
  chatCreateSchema,
  chatForkSchema,
  chatListSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatModelUpdateSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  chatSummarySchema,
  chatTurnCreateSchema,
  chatUpdateSchema,
  explorerCreateSchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerListSchema,
  explorerSummarySchema,
  explorerUpdateSchema,
  githubAuthStatusSchema,
  githubIssueCloseSchema,
  githubIssueCommentCreateSchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubIssueStateSchema,
  githubProjectCreateSchema,
  githubRepositoryListSchema,
  githubWorkerRepositoryListSchema,
  gitActionResultSchema,
  gitActionSchema,
  gitHistorySchema,
  gitStatusSchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderCreateSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  mentionedSkillNames,
  orderedIdsSchema,
  projectCloneResultSchema,
  projectListSchema,
  projectRemoveSchema,
  projectSummarySchema,
  projectViewCreateSchema,
  projectViewListSchema,
  projectViewSummarySchema,
  projectViewUpdateSchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptOrderSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  skillListSchema,
  systemHealthSchema,
  terminalClientMessageSchema,
  terminalCreateSchema,
  terminalListSchema,
  terminalOpenResultSchema,
  terminalServerMessageSchema,
  terminalSummarySchema,
  terminalUpdateSchema,
  userSettingsUpdateSchema,
  workerHeartbeatSchema,
  workerListSchema,
} from "@cantrip/protocol";
import Fastify from "fastify";
import type { ChatMessage, ChatTurnCreate } from "@cantrip/protocol";

import { fetchBrowserPage } from "./browser-proxy.js";
import type { ServerConfig } from "./config.js";
import type { DatabaseConnection } from "./db/index.js";
import {
  LOCAL_USER_ID,
  type ChatExecutionContext,
  type ModelRuntime,
} from "./db/repository.js";
import {
  WorkerBridge,
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "./workers/bridge.js";

export interface BuildAppOptions {
  config: ServerConfig;
  database: DatabaseConnection;
  logger?: boolean;
  workerBridge?: WorkerCommandBus;
}

function invalidBody(issues: unknown) {
  return { error: "Invalid request body", issues };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ROUTE_FAILURE_COOLDOWN_MS = 60_000;

function canFailOverRoute(error: unknown): boolean {
  return /(quota|usage limit|rate.?limit|\b429\b|unauthori[sz]ed|\b401\b|forbidden|\b403\b|authentication|credentials|model.+(?:not found|unavailable)|\b404\b|timed? out|timeout|ECONN|connection|network|socket|\b5\d\d\b|service unavailable|overloaded)/i.test(
    errorMessage(error),
  );
}

function continuationPrompt(messages: ChatMessage[], prompt: string): string {
  if (messages.length === 0) return prompt;
  const transcript = messages
    .slice(-100)
    .map((message) => {
      const content = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.activity.type === "command") {
            return [`[command: ${item.activity.command}]`];
          }
          return [
            `[files: ${item.activity.changes.map((change) => change.path).join(", ")}]`,
          ];
        })
        .join("\n");
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
  return `Continue this existing Cantrip conversation. The server-owned history follows:\n\n${transcript}\n\nUSER: ${prompt}`;
}

export async function buildApp({
  config,
  database,
  logger = true,
  workerBridge,
}: BuildAppOptions) {
  const app = Fastify({ logger });
  const bridge = workerBridge ?? new WorkerBridge();
  const repository = database.repository;
  const [serverId, currentUser] = await Promise.all([
    repository.getOrCreateServerId(),
    repository.ensureLocalIdentity(),
  ]);
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );

  await app.register(cors, {
    credentials: true,
    origin: config.appOrigins,
  });
  await app.register(websocket);

  const dispatchingChats = new Set<string>();
  const pendingQueueDispatches = new Set<string>();
  const projectSetupTasks = new Set<Promise<void>>();
  const routeCooldowns = new Map<string, number>();

  const queueProjectSetup = (
    projectId: string,
    input: {
      nameWithOwner: string;
      workerId: string;
    },
  ) => {
    const task = (async () => {
      try {
        const clone = projectCloneResultSchema.parse(
          await bridge.request(
            input.workerId,
            {
              type: "project.clone",
              repository: { nameWithOwner: input.nameWithOwner },
            },
            { timeoutMs: null },
          ),
        );
        await repository.completeGithubProjectSetup(
          LOCAL_USER_ID,
          projectId,
          input.workerId,
          clone,
        );
      } catch (error) {
        const message =
          errorMessage(error).trim().slice(0, 4_000) ||
          "Repository setup failed.";
        try {
          await repository.failGithubProjectSetup(
            LOCAL_USER_ID,
            projectId,
            message,
          );
        } catch (persistenceError) {
          app.log.error(
            { error: persistenceError, projectId },
            "Could not record failed project setup",
          );
        }
      }
    })();
    projectSetupTasks.add(task);
    void task.finally(() => projectSetupTasks.delete(task));
  };

  const resolveModelId = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ): Promise<string> => {
    const defaultModelId = context.modelId
      ? null
      : (await repository.getSettings(LOCAL_USER_ID)).preferences
          .defaultModelId;
    const modelId = requestedModelId ?? context.modelId ?? defaultModelId;
    if (!modelId) {
      throw new Error(
        "Choose a model or configure a default model in Settings.",
      );
    }
    return modelId;
  };

  const availableModelRuntimes = async (
    context: ChatExecutionContext,
    modelId: string,
  ): Promise<ModelRuntime[]> => {
    const runtimes = await repository.getModelRuntimes(LOCAL_USER_ID, modelId);
    if (!runtimes.length) {
      throw new Error("The selected model has no enabled provider routes.");
    }
    const now = Date.now();
    const available: ModelRuntime[] = [];
    const unavailable: string[] = [];
    for (const runtime of runtimes) {
      const cooldownUntil = routeCooldowns.get(runtime.routeId) ?? 0;
      if (cooldownUntil > now) {
        unavailable.push(`${runtime.provider.name} is cooling down`);
        continue;
      }
      if (runtime.provider.kind === "chatgpt") {
        try {
          const status = codexAuthStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "codex.auth.status",
              providerId: runtime.provider.id,
            }),
          );
          if (!status.authenticated || status.authMode !== "chatgpt") {
            unavailable.push(`${runtime.provider.name} is not signed in`);
            continue;
          }
          if ((status.weeklyUsage?.usedPercent ?? 0) >= 100) {
            unavailable.push(
              `${runtime.provider.name} has no weekly usage left`,
            );
            continue;
          }
        } catch (error) {
          app.log.warn(
            { err: error, providerId: runtime.provider.id },
            "Could not preflight ChatGPT route; attempting it directly",
          );
        }
      }
      available.push(runtime);
    }
    if (!available.length) {
      throw new Error(
        `No provider route is currently available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
      );
    }
    return available;
  };

  const runtimeForContext = async (
    context: ChatExecutionContext,
  ): Promise<ModelRuntime | null> => {
    if (context.modelRouteId) {
      const active = await repository.getModelRuntimeByRoute(
        LOCAL_USER_ID,
        context.modelRouteId,
      );
      if (active) return active;
    }
    const modelId = await resolveModelId(context);
    return repository.getModelRuntime(LOCAL_USER_ID, modelId);
  };

  const dispatchNextQueuedPrompt = async (chatId: string): Promise<void> => {
    if (dispatchingChats.has(chatId)) {
      pendingQueueDispatches.add(chatId);
      return;
    }
    dispatchingChats.add(chatId);
    try {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chatId,
      );
      if (!context || context.status === "running") return;
      const prompt = (
        await repository.listQueuedPrompts(LOCAL_USER_ID, chatId)
      ).find((candidate) => !candidate.frozen);
      if (!prompt) return;
      await beginTurn(context, {
        text: prompt.text,
        modelId: prompt.modelId,
        idempotencyKey: `queue:${prompt.id}`,
      });
      await repository.deleteQueuedPrompt(LOCAL_USER_ID, prompt.id);
    } catch (error) {
      app.log.error({ chatId, err: error }, "Queued prompt dispatch failed");
    } finally {
      dispatchingChats.delete(chatId);
      if (pendingQueueDispatches.delete(chatId)) {
        void dispatchNextQueuedPrompt(chatId);
      }
    }
  };

  async function beginTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    if (!bridge.isConnected(context.workerId)) {
      throw new Error("Project worker is offline.");
    }
    const modelId = await resolveModelId(context, input.modelId);
    const runtimes = await availableModelRuntimes(context, modelId);
    const priorMessages = await repository.listMessages(
      LOCAL_USER_ID,
      context.chatId,
    );
    const userMessage = await repository.appendMessage(
      LOCAL_USER_ID,
      context.chatId,
      {
        role: "user",
        content: [{ type: "text", text: input.text }],
        idempotencyKey: input.idempotencyKey,
      },
    );
    if (!userMessage) {
      throw new Error("Chat not found.");
    }
    await repository.setMessageModelRoute(
      userMessage.id,
      modelId,
      runtimes[0]!,
    );
    await repository.setChatModel(LOCAL_USER_ID, context.chatId, { modelId });
    await repository.setChatStatus(context.chatId, "running");

    void (async () => {
      let anyActivity = false;
      try {
        for (const [index, runtime] of runtimes.entries()) {
          let attemptActivity = false;
          const canResume = runtime.routeId === context.modelRouteId;
          const threadId = canResume ? context.threadId : null;
          const workerPrompt = threadId
            ? input.text
            : continuationPrompt(priorMessages, input.text);
          await repository.setMessageModelRoute(
            userMessage.id,
            modelId,
            runtime,
          );
          await repository.updateChatRuntime(
            context.chatId,
            context.workerId,
            threadId,
            runtime.routeId,
            "starting",
          );
          try {
            const rawResult = await bridge.request(
              context.workerId,
              {
                type: "chat.turn",
                chatId: context.chatId,
                clientMessageId: userMessage.id,
                cwd: context.cwd,
                threadId,
                prompt: workerPrompt,
                skillNames: mentionedSkillNames(input.text),
                model: runtime.model,
                provider: runtime.provider,
              },
              {
                timeoutMs: null,
                onEvent: async (event) => {
                  if (event.type !== "agent.activity") return;
                  attemptActivity = true;
                  anyActivity = true;
                  await repository.upsertMessage(
                    LOCAL_USER_ID,
                    context.chatId,
                    {
                      role: "assistant",
                      content: [{ type: "activity", activity: event.activity }],
                      idempotencyKey: `activity:${userMessage.id}:${event.activity.id}`,
                    },
                  );
                },
              },
            );
            const result = agentTurnResultSchema.parse(rawResult);
            routeCooldowns.delete(runtime.routeId);
            await repository.updateChatRuntime(
              context.chatId,
              context.workerId,
              result.threadId,
              runtime.routeId,
            );
            await repository.appendMessage(LOCAL_USER_ID, context.chatId, {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: result.text || "The agent completed without a message.",
                },
              ],
              idempotencyKey: `assistant:${userMessage.id}`,
            });
            await repository.setChatStatus(context.chatId, "idle");
            void dispatchNextQueuedPrompt(context.chatId);
            return;
          } catch (error) {
            const canRetry =
              !attemptActivity &&
              canFailOverRoute(error) &&
              index < runtimes.length - 1;
            if (!canRetry) throw error;
            routeCooldowns.set(
              runtime.routeId,
              Date.now() + ROUTE_FAILURE_COOLDOWN_MS,
            );
            app.log.warn(
              {
                chatId: context.chatId,
                err: error,
                providerId: runtime.provider.id,
                routeId: runtime.routeId,
              },
              "Provider route failed before activity; trying the next route",
            );
          }
        }
      } catch (error: unknown) {
        if (!anyActivity && context.modelRouteId) {
          await repository.updateChatRuntime(
            context.chatId,
            context.workerId,
            context.threadId,
            context.modelRouteId,
          );
        }
        const interrupted = /interrupted/i.test(errorMessage(error));
        app.log.error(
          { chatId: context.chatId, err: error },
          "Agent turn failed",
        );
        await repository.appendMessage(LOCAL_USER_ID, context.chatId, {
          role: "system",
          content: [
            {
              type: "text",
              text: interrupted
                ? "Turn interrupted."
                : `Agent failed: ${errorMessage(error)}`,
            },
          ],
          idempotencyKey: `error:${userMessage.id}`,
        });
        await repository.setChatStatus(
          context.chatId,
          interrupted ? "idle" : "failed",
        );
        void dispatchNextQueuedPrompt(context.chatId);
      }
    })();

    const firstRuntime = runtimes[0]!;
    return {
      ...userMessage,
      modelId,
      modelRouteId: firstRuntime.routeId,
      providerId: firstRuntime.provider.id,
      providerName: firstRuntime.provider.name,
      providerModelName: firstRuntime.model.name,
    };
  }

  app.get("/api", async () => ({
    name: "cantrip_server",
    version: "0.0.0",
  }));

  app.get("/api/bootstrap", async (_request, reply) => {
    return reply.send(
      serverBootstrapSchema.parse({
        protocolVersion: 1,
        server: {
          id: serverId,
          deploymentMode: config.deploymentMode,
          bootstrapMode: config.bootstrapMode,
        },
        auth: {
          mode: config.authMode,
          currentUser,
        },
        routing: {
          workerConnection: "server-only",
          directWorkerConnections: false,
        },
        storage: {
          conversations: "server",
          files: "worker",
        },
        agent: {
          model: config.agentModel,
          modelProvider: config.agentModelProvider,
        },
        capabilities: {
          accounts: false,
          passwordProtection: false,
          linkCodes: false,
          multipleWorkers: false,
          workerSwitching: false,
          gitSync: false,
          worktrees: false,
        },
      }),
    );
  });

  app.get("/api/health", { logLevel: "warn" }, async (_request, reply) => {
    await database.ping();
    return reply.send(
      systemHealthSchema.parse({
        status: "ok",
        service: "cantrip_server",
        database: { engine: database.engine, ready: true },
        workers: {
          connected: await repository.onlineWorkerCount(LOCAL_USER_ID),
        },
        timestamp: new Date().toISOString(),
      }),
    );
  });

  app.get<{ Querystring: { url?: string } }>(
    "/api/browser/proxy",
    async (request, reply) => {
      if (!request.query.url) {
        return reply.code(400).send({ error: "url is required" });
      }
      try {
        const page = await fetchBrowserPage(request.query.url);
        return reply
          .code(page.status)
          .header("content-type", page.contentType)
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .send(page.body);
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.get("/api/workers", { logLevel: "warn" }, async (_request, reply) => {
    const workers = await repository.listWorkers(LOCAL_USER_ID);
    return reply.send(workerListSchema.parse(workers));
  });

  app.get<{ Querystring: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/status",
    async (request, reply) => {
      const { providerId, workerId } = request.query;
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        const status = codexAuthStatusSchema.parse(
          await bridge.request(workerId, {
            type: "codex.auth.status",
            providerId,
          }),
        );
        return reply.send(status);
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/device-login",
    async (request, reply) => {
      const { providerId, workerId } = request.body ?? {};
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        return reply.send(
          codexDeviceLoginSchema.parse(
            await bridge.request(workerId, {
              type: "codex.auth.login.start",
              providerId,
            }),
          ),
        );
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: { providerId?: string; workerId?: string } }>(
    "/api/codex/auth/logout",
    async (request, reply) => {
      const { providerId, workerId } = request.body ?? {};
      if (!workerId || !providerId) {
        return reply
          .code(400)
          .send({ error: "workerId and providerId are required" });
      }
      const provider = await repository.getModelProvider(
        LOCAL_USER_ID,
        providerId,
      );
      if (provider?.kind !== "chatgpt") {
        return reply
          .code(404)
          .send({ error: "ChatGPT account provider not found." });
      }
      try {
        await bridge.request(workerId, {
          type: "codex.auth.logout",
          providerId,
        });
        return reply.code(204).send();
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.get("/api/settings", async (_request, reply) => {
    return reply.send(
      settingsBundleSchema.parse(await repository.getSettings(LOCAL_USER_ID)),
    );
  });

  app.patch("/api/settings", async (request, reply) => {
    const input = userSettingsUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const settings = await repository.updateSettings(LOCAL_USER_ID, input.data);
    if (!settings) {
      return reply.code(400).send({ error: "Default model was not found." });
    }
    return reply.send(settingsBundleSchema.parse(settings));
  });

  app.post("/api/settings/providers", async (request, reply) => {
    const input = modelProviderCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const provider = await repository.createModelProvider(
        LOCAL_USER_ID,
        input.data,
      );
      return reply.code(201).send(modelProviderSummarySchema.parse(provider));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      try {
        const deleted = await repository.deleteModelProvider(
          LOCAL_USER_ID,
          request.params.providerId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Provider not found." });
      } catch {
        return reply.code(409).send({
          error: "Delete the provider's models before deleting the provider.",
        });
      }
    },
  );

  app.patch<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId",
    async (request, reply) => {
      const input = modelProviderUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const provider = await repository.updateModelProvider(
          LOCAL_USER_ID,
          request.params.providerId,
          input.data,
        );
        return provider
          ? reply.send(modelProviderSummarySchema.parse(provider))
          : reply.code(404).send({ error: "Provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post("/api/settings/models", async (request, reply) => {
    const input = modelProfileCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const model = await repository.createModelProfile(
        LOCAL_USER_ID,
        input.data,
      );
      if (!model) {
        return reply.code(404).send({ error: "Provider not found." });
      }
      return reply.code(201).send(modelProfileSummarySchema.parse(model));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      try {
        const deleted = await repository.deleteModelProfile(
          LOCAL_USER_ID,
          request.params.modelId,
        );
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Model not found." });
      } catch {
        return reply.code(409).send({
          error: "This model is the default or selected by an existing chat.",
        });
      }
    },
  );

  app.patch<{ Params: { modelId: string } }>(
    "/api/settings/models/:modelId",
    async (request, reply) => {
      const input = modelProfileUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const model = await repository.updateModelProfile(
          LOCAL_USER_ID,
          request.params.modelId,
          input.data,
        );
        return model
          ? reply.send(modelProfileSummarySchema.parse(model))
          : reply.code(404).send({ error: "Model or provider not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/status",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const result = await bridge.request(workerId, {
          type: "github.auth.status",
        });
        return reply.send(githubAuthStatusSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { login?: string; workerId?: string } }>(
    "/api/github/repositories/cache",
    async (request, reply) => {
      const workerId = request.query.workerId;
      const login = request.query.login;
      if (!workerId || !login) {
        return reply
          .code(400)
          .send({ error: "workerId and login are required" });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.cached",
            login,
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(LOCAL_USER_ID);
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/repositories",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.list",
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(LOCAL_USER_ID);
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get("/api/projects", async (_request, reply) => {
    const projects = await repository.listProjects(LOCAL_USER_ID);
    return reply.send(projectListSchema.parse(projects));
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/projects/:projectId/git/history", async (request, reply) => {
    const source = await repository.getProjectSource(
      LOCAL_USER_ID,
      request.params.projectId,
    );
    if (!source) {
      return reply.code(404).send({ error: "Project source not found." });
    }
    const parsedLimit = Number.parseInt(request.query.limit ?? "100", 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 100;
    const parsedCursor = Number.parseInt(request.query.cursor ?? "0", 10);
    const cursor = Number.isFinite(parsedCursor)
      ? Math.max(0, parsedCursor)
      : 0;
    try {
      const history = await bridge.request(source.workerId, {
        type: "git.history",
        cwd: source.cwd,
        cursor,
        limit,
      });
      return reply.send(gitHistorySchema.parse(history));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { state?: string };
  }>("/api/projects/:projectId/github/issues", async (request, reply) => {
    const state = githubIssueStateSchema.safeParse(
      request.query.state ?? "open",
    );
    if (!state.success) {
      return reply.code(400).send({ error: "state must be open or closed" });
    }
    const context = await repository.getGithubProjectExecutionContext(
      LOCAL_USER_ID,
      request.params.projectId,
    );
    if (!context) {
      return reply.code(404).send({ error: "GitHub project not found." });
    }
    try {
      const issues = await bridge.request(context.workerId, {
        type: "github.issues.list",
        repository: context.nameWithOwner,
        state: state.data,
      });
      return reply.send(githubIssueListSchema.parse(issues));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.get",
          repository: context.nameWithOwner,
          number: issueNumber,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/comments",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCommentCreateSchema.safeParse(request.body);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.comment",
          repository: context.nameWithOwner,
          number: issueNumber,
          body: input.data.body,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { issueNumber: string; projectId: string } }>(
    "/api/projects/:projectId/github/issues/:issueNumber/close",
    async (request, reply) => {
      const issueNumber = Number.parseInt(request.params.issueNumber, 10);
      const input = githubIssueCloseSchema.safeParse(request.body ?? {});
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        return reply.code(400).send({ error: "Invalid issue number." });
      }
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getGithubProjectExecutionContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "GitHub project not found." });
      }
      try {
        const issue = await bridge.request(context.workerId, {
          type: "github.issue.close",
          repository: context.nameWithOwner,
          number: issueNumber,
          comment: input.data.comment,
        });
        return reply.send(githubIssueDetailSchema.parse(issue));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/status",
    async (request, reply) => {
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const status = await bridge.request(source.workerId, {
          type: "git.status",
          cwd: source.cwd,
        });
        return reply.send(gitStatusSchema.parse(status));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/actions",
    async (request, reply) => {
      const input = gitActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const source = await repository.getProjectSource(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const result = await bridge.request(source.workerId, {
          type: "git.action",
          cwd: source.cwd,
          action: input.data,
        });
        return reply.send(gitActionResultSchema.parse(result));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.patch("/api/projects/order", async (request, reply) => {
    const input = orderedIdsSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    return (await repository.reorderProjects(LOCAL_USER_ID, input.data))
      ? reply.code(204).send()
      : reply.code(400).send({ error: "Project order did not match." });
  });

  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const input = projectRemoveSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectRemovalContext(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (context.setupStatus === "cloning") {
        return reply
          .code(409)
          .send({ error: "Wait for the repository clone to finish." });
      }
      const { cwd, workerId } = context;

      try {
        if (input.data.deleteLocalFiles && cwd && workerId) {
          await Promise.all(
            context.terminalIds.map((terminalId) =>
              bridge.request(workerId, {
                type: "terminal.close",
                terminalId,
              }),
            ),
          );
          await bridge.request(workerId, {
            type: "project.files.delete",
            path: cwd,
          });
        } else if (workerId && bridge.isConnected(workerId)) {
          for (const terminalId of context.terminalIds) {
            void bridge
              .request(workerId, {
                type: "terminal.close",
                terminalId,
              })
              .catch(() => undefined);
          }
        }
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }

      return (await repository.deleteProject(
        LOCAL_USER_ID,
        request.params.projectId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.post("/api/projects/from-github", async (request, reply) => {
    const input = githubProjectCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (
      await repository.hasGithubProject(LOCAL_USER_ID, input.data.repositoryId)
    ) {
      return reply.code(409).send({
        error: "This GitHub repository already has a Cantrip project.",
      });
    }

    try {
      const project = await repository.createGithubProject(
        LOCAL_USER_ID,
        input.data,
      );
      queueProjectSetup(project.id, input.data);
      return reply.code(202).send(projectSummarySchema.parse(project));
    } catch (error) {
      if (
        await repository.hasGithubProject(
          LOCAL_USER_ID,
          input.data.repositoryId,
        )
      ) {
        return reply.code(409).send({
          error: "This GitHub repository already has a Cantrip project.",
        });
      }
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const chats = await repository.listChats(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(chatListSchema.parse(chats));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const input = chatCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const chat = await repository.createChat(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      if (!chat) {
        return reply.code(404).send({ error: "Project source not found" });
      }
      return reply.code(201).send(chatSummarySchema.parse(chat));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/console",
    async (request, reply) => {
      const terminal = await repository.getOrCreateChatConsole(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      return terminal
        ? reply.code(201).send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Chat source not found." });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const terminals = await repository.listTerminals(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(terminalListSchema.parse(terminals));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const input = terminalCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const terminal = await repository.createTerminal(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return terminal
        ? reply.code(201).send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const input = terminalUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const terminal = await repository.updateTerminal(
        LOCAL_USER_ID,
        request.params.terminalId,
        input.data,
      );
      return terminal
        ? reply.send(terminalSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Terminal not found." });
    },
  );

  app.delete<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const context = await repository.deleteTerminal(
        LOCAL_USER_ID,
        request.params.terminalId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Terminal not found." });
      }
      if (bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "terminal.close",
            terminalId: context.terminalId,
          })
          .catch((error: unknown) =>
            app.log.warn(
              { err: error, terminalId: context.terminalId },
              "Could not close deleted terminal",
            ),
          );
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) => {
      const explorers = await repository.listExplorers(
        LOCAL_USER_ID,
        request.params.projectId,
      );
      return reply.send(explorerListSchema.parse(explorers));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) =>
      reply.send(
        browserListSchema.parse(
          await repository.listBrowsers(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) => {
      const input = browserCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const browser = await repository.createBrowser(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return browser
        ? reply.code(201).send(browserSummarySchema.parse(browser))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) => {
      const input = browserUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const browser = await repository.updateBrowser(
        LOCAL_USER_ID,
        request.params.browserId,
        input.data,
      );
      return browser
        ? reply.send(browserSummarySchema.parse(browser))
        : reply.code(404).send({ error: "Browser not found." });
    },
  );

  app.delete<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) =>
      (await repository.deleteBrowser(LOCAL_USER_ID, request.params.browserId))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Browser not found." }),
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) =>
      reply.send(
        projectViewListSchema.parse(
          await repository.listProjectViews(
            LOCAL_USER_ID,
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) => {
      const input = projectViewCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const view = await repository.createProjectView(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return view
        ? reply.code(201).send(projectViewSummarySchema.parse(view))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) => {
      const input = projectViewUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const view = await repository.updateProjectView(
        LOCAL_USER_ID,
        request.params.viewId,
        input.data,
      );
      return view
        ? reply.send(projectViewSummarySchema.parse(view))
        : reply.code(404).send({ error: "Project view not found." });
    },
  );

  app.delete<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) =>
      (await repository.deleteProjectView(LOCAL_USER_ID, request.params.viewId))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Project view not found." }),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) => {
      const input = explorerCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.createExplorer(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      );
      return explorer
        ? reply.code(201).send(explorerSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Project source not found." });
    },
  );

  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) => {
      const input = explorerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.updateExplorer(
        LOCAL_USER_ID,
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer not found." });
    },
  );

  app.delete<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) =>
      (await repository.deleteExplorer(
        LOCAL_USER_ID,
        request.params.explorerId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Explorer not found." }),
  );

  app.get<{
    Params: { explorerId: string };
    Querystring: { path?: string };
  }>("/api/explorers/:explorerId/directory", async (request, reply) => {
    const context = await repository.getExplorerExecutionContext(
      LOCAL_USER_ID,
      request.params.explorerId,
    );
    if (!context) return reply.code(404).send({ error: "Explorer not found." });
    try {
      const directory = await bridge.request(context.workerId, {
        type: "explorer.directory.list",
        root: context.root,
        path: request.query.path ?? "",
      });
      return reply.send(explorerDirectorySchema.parse(directory));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{
    Params: { explorerId: string };
    Querystring: { path?: string };
  }>("/api/explorers/:explorerId/file", async (request, reply) => {
    if (!request.query.path) {
      return reply.code(400).send({ error: "A file path is required." });
    }
    const context = await repository.getExplorerExecutionContext(
      LOCAL_USER_ID,
      request.params.explorerId,
    );
    if (!context) return reply.code(404).send({ error: "Explorer not found." });
    try {
      const file = await bridge.request(context.workerId, {
        type: "explorer.file.read",
        root: context.root,
        path: request.query.path,
      });
      return reply.send(explorerFileSchema.parse(file));
    } catch (error) {
      const status = error instanceof WorkerUnavailableError ? 503 : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      const attachmentId = randomUUID();
      let terminalId: string | null = null;
      let workerId: string | null = null;
      let closed = false;
      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          socket.send(
            JSON.stringify(terminalServerMessageSchema.parse(message)),
          );
        }
      };

      socket.on("close", () => {
        closed = true;
        if (!terminalId || !workerId || !bridge.isConnected(workerId)) return;
        void bridge
          .request(workerId, {
            type: "terminal.detach",
            terminalId,
            attachmentId,
          })
          .catch(() => undefined);
      });

      socket.on("message", (raw) => {
        if (!terminalId || !workerId) return;
        let value: unknown;
        try {
          value = JSON.parse(raw.toString());
        } catch {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        const message = terminalClientMessageSchema.safeParse(value);
        if (!message.success) {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        const command =
          message.data.type === "input"
            ? {
                type: "terminal.input" as const,
                terminalId,
                data: message.data.data,
              }
            : {
                type: "terminal.resize" as const,
                terminalId,
                cols: message.data.cols,
                rows: message.data.rows,
              };
        void bridge
          .request(workerId, command, { timeoutMs: 30_000 })
          .catch((error: unknown) => {
            send({ type: "error", message: errorMessage(error) });
          });
      });

      void (async () => {
        const context = await repository.getTerminalExecutionContext(
          LOCAL_USER_ID,
          request.params.terminalId,
        );
        if (!context) {
          send({ type: "error", message: "Terminal not found." });
          socket.close(1008, "Terminal not found");
          return;
        }
        if (closed) return;
        terminalId = context.terminalId;
        workerId = context.workerId;
        if (!bridge.isConnected(workerId)) {
          await repository.setTerminalStatus(terminalId, "offline");
          send({ type: "error", message: "Project worker is offline." });
          socket.close(1013, "Worker offline");
          return;
        }
        if (closed) {
          await repository.setTerminalStatus(terminalId, "idle");
          return;
        }
        try {
          let launch:
            | { type: "shell" }
            | {
                type: "codex";
                threadId: string | null;
                model: ModelRuntime["model"];
                provider: ModelRuntime["provider"];
              } = { type: "shell" };
          if (context.linkedChatId) {
            const chat = await repository.getChatExecutionContext(
              LOCAL_USER_ID,
              context.linkedChatId,
            );
            const runtime = chat ? await runtimeForContext(chat) : null;
            if (!chat || !runtime) {
              throw new Error(
                "Choose a model for this chat before opening its Codex console.",
              );
            }
            launch = {
              type: "codex",
              threadId: chat.threadId,
              model: runtime.model,
              provider: runtime.provider,
            };
          }
          const result = terminalOpenResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "terminal.open",
                terminalId,
                attachmentId,
                cwd: context.cwd,
                cols: 80,
                rows: 24,
                launch,
              },
              {
                timeoutMs: null,
                onEvent: async (event) => {
                  if (event.type === "terminal.ready") {
                    if (closed) {
                      await bridge.request(workerId!, {
                        type: "terminal.detach",
                        terminalId: terminalId!,
                        attachmentId,
                      });
                      return;
                    }
                    await repository.setTerminalStatus(terminalId!, "running");
                    send({ type: "ready" });
                  } else if (event.type === "terminal.output") {
                    send({ type: "output", data: event.data });
                  }
                },
              },
            ),
          );
          if (result.status === "exited") {
            await repository.setTerminalStatus(terminalId, "exited");
            if (!closed) send({ type: "exit", ...result });
          }
        } catch (error) {
          await repository.setTerminalStatus(
            terminalId,
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          );
          if (!closed) send({ type: "error", message: errorMessage(error) });
        }
      })();
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tabs/order",
    async (request, reply) => {
      const input = orderedIdsSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      return (await repository.reorderProjectTabs(
        LOCAL_USER_ID,
        request.params.projectId,
        input.data,
      ))
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Tab order did not match." });
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const input = chatUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const chat = await repository.updateChat(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      return chat
        ? reply.send(chatSummarySchema.parse(chat))
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const result = await repository.deleteChat(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (result === "running") {
        return reply.code(409).send({ error: "Stop the running chat first." });
      }
      return result
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Chat not found." });
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/fork",
    async (request, reply) => {
      const input = chatForkSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const chat = await repository.forkChat(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data.messageId,
      );
      return chat
        ? reply.code(201).send(chatSummarySchema.parse(chat))
        : reply.code(404).send({ error: "Chat or message not found." });
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/compact",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.status === "running") {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (!context.threadId) {
        return reply
          .code(409)
          .send({ error: "Send a message before compacting this chat." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const result = await bridge.request(context.workerId, {
        type: "chat.compact",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      });
      return reply.send(chatCompactAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/interrupt",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId || context.status !== "running") {
        return reply.send(
          chatInterruptAcceptedSchema.parse({ interrupted: false }),
        );
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const result = await bridge.request(context.workerId, {
        type: "chat.interrupt",
        chatId: context.chatId,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      });
      return reply.send(chatInterruptAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/sync",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (!context.threadId) {
        return reply.send(
          agentThreadSyncSchema.parse({
            threadId: "unavailable",
            status: "idle",
            turns: [],
          }),
        );
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const sync = agentThreadSyncSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.sync",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
        }),
      );
      for (const turn of sync.turns) {
        for (const item of turn.items) {
          if (item.type === "userMessage") {
            await repository.upsertMessage(LOCAL_USER_ID, context.chatId, {
              role: "user",
              content: [{ type: "text", text: item.text }],
              idempotencyKey: `codex-sync:${turn.id}:${item.id}`,
            });
          } else if (
            item.type === "agentMessage" &&
            item.phase !== "commentary"
          ) {
            await repository.upsertMessage(LOCAL_USER_ID, context.chatId, {
              role: "assistant",
              content: [{ type: "text", text: item.text }],
              idempotencyKey: `codex-sync:${turn.id}:${item.id}`,
            });
          } else if (item.type === "activity") {
            await repository.upsertMessage(LOCAL_USER_ID, context.chatId, {
              role: "assistant",
              content: [{ type: "activity", activity: item.activity }],
              idempotencyKey: `codex-sync:${turn.id}:${item.activity.id}`,
            });
          }
        }
        if (turn.status === "failed" || turn.status === "interrupted") {
          await repository.upsertMessage(LOCAL_USER_ID, context.chatId, {
            role: "system",
            content: [
              {
                type: "text",
                text:
                  turn.status === "interrupted"
                    ? "Turn interrupted in the Codex console."
                    : "The Codex console turn failed.",
              },
            ],
            idempotencyKey: `codex-sync:${turn.id}:status`,
          });
        }
      }
      if (sync.turns.length > 0) {
        await repository.setChatStatus(context.chatId, sync.status);
        if (sync.status === "idle")
          void dispatchNextQueuedPrompt(context.chatId);
      }
      return reply.send(sync);
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/messages",
    async (request, reply) => {
      const messages = await repository.listMessages(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      return reply.send(chatMessageListSchema.parse(messages));
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/skills",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Choose a model before listing skills." });
        }
        const skills = await bridge.request(context.workerId, {
          type: "skills.list",
          cwd: context.cwd,
          model: runtime.model,
          provider: runtime.provider,
        });
        return reply.send(skillListSchema.parse(skills));
      } catch (error) {
        const status = error instanceof WorkerUnavailableError ? 503 : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/messages",
    async (request, reply) => {
      const input = chatMessageCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const message = await repository.appendMessage(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      if (!message) {
        return reply.code(404).send({ error: "Chat not found" });
      }
      return reply.code(201).send(chatMessageSchema.parse(message));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/model",
    async (request, reply) => {
      const input = chatModelUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const result = await repository.setChatModel(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      if (!result) {
        return reply.code(404).send({ error: "Chat or model not found." });
      }
      return reply.send(chatSummarySchema.parse(result));
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      return reply.send(
        queuedPromptListSchema.parse(
          await repository.listQueuedPrompts(
            LOCAL_USER_ID,
            request.params.chatId,
          ),
        ),
      );
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue",
    async (request, reply) => {
      const input = queuedPromptCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });
      let modelId: string;
      try {
        modelId = await resolveModelId(context, input.data.modelId);
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      const prompt = await repository.createQueuedPrompt(
        LOCAL_USER_ID,
        context.chatId,
        input.data,
        modelId,
      );
      if (!prompt) return reply.code(404).send({ error: "Chat not found." });
      if (!prompt.frozen) void dispatchNextQueuedPrompt(context.chatId);
      return reply.code(201).send(queuedPromptSchema.parse(prompt));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/queue/order",
    async (request, reply) => {
      const input = queuedPromptOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const reordered = await repository.reorderQueuedPrompts(
        LOCAL_USER_ID,
        request.params.chatId,
        input.data,
      );
      return reordered
        ? reply.code(204).send()
        : reply.code(400).send({ error: "Queued prompt order is invalid." });
    },
  );

  app.patch<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const input = queuedPromptUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const prompt = await repository.updateQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
        input.data,
      );
      if (!prompt) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      if (!prompt.frozen) void dispatchNextQueuedPrompt(prompt.chatId);
      return reply.send(queuedPromptSchema.parse(prompt));
    },
  );

  app.delete<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId",
    async (request, reply) => {
      const prompt = await repository.deleteQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
      );
      return prompt
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Queued prompt not found." });
    },
  );

  app.post<{ Params: { promptId: string } }>(
    "/api/queued-prompts/:promptId/steer",
    async (request, reply) => {
      const queued = await repository.getQueuedPrompt(
        LOCAL_USER_ID,
        request.params.promptId,
      );
      if (!queued) {
        return reply.code(404).send({ error: "Queued prompt not found." });
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        queued.chatId,
      );
      if (!context) return reply.code(404).send({ error: "Chat not found." });

      try {
        let message: ChatMessage;
        if (context.status === "running") {
          if (!bridge.isConnected(context.workerId)) {
            throw new Error("The active Codex thread is unavailable.");
          }
          const runtime = await runtimeForContext(context);
          if (!runtime) throw new Error("Selected model was not found.");
          await bridge.request(context.workerId, {
            type: "chat.steer",
            chatId: context.chatId,
            threadId: context.threadId,
            prompt: queued.text,
            model: runtime.model,
            provider: runtime.provider,
          });
          const appended = await repository.appendMessage(
            LOCAL_USER_ID,
            context.chatId,
            {
              role: "user",
              content: [{ type: "text", text: queued.text }],
              idempotencyKey: `steer:${queued.id}`,
            },
          );
          if (!appended) throw new Error("Chat not found.");
          message = appended;
        } else {
          message = await beginTurn(context, {
            text: queued.text,
            modelId: queued.modelId,
            idempotencyKey: `queue:${queued.id}`,
          });
        }
        await repository.deleteQueuedPrompt(LOCAL_USER_ID, queued.id);
        return reply.send(
          chatPromptSteerResultSchema.parse({ steered: true, message }),
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/turns",
    async (request, reply) => {
      const input = chatTurnCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found" });
      }
      const existing = await repository.getMessageByIdempotencyKey(
        LOCAL_USER_ID,
        context.chatId,
        input.data.idempotencyKey,
      );
      if (existing) {
        return reply.send(
          chatPromptSubmitResultSchema.parse({
            status: "started",
            message: existing,
          }),
        );
      }
      if (context.status === "running") {
        let modelId: string;
        try {
          modelId = await resolveModelId(context, input.data.modelId);
        } catch (error) {
          return reply.code(409).send({ error: errorMessage(error) });
        }
        const prompt = await repository.createQueuedPrompt(
          LOCAL_USER_ID,
          context.chatId,
          { ...input.data, modelId, frozen: false },
          modelId,
        );
        return prompt
          ? reply.code(202).send(
              chatPromptSubmitResultSchema.parse({
                status: "queued",
                prompt,
              }),
            )
          : reply.code(404).send({ error: "Chat not found." });
      }

      try {
        const message = await beginTurn(context, input.data);
        return reply.code(202).send(
          chatPromptSubmitResultSchema.parse({
            status: "started",
            message,
          }),
        );
      } catch (error) {
        const message = errorMessage(error);
        const status = message.includes("offline")
          ? 503
          : message.includes("model") || message.includes("Model")
            ? 409
            : 400;
        return reply.code(status).send({ error: message });
      }
    },
  );

  app.post(
    "/api/internal/workers/heartbeat",
    { logLevel: "warn" },
    async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${config.workerToken}`) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const heartbeat = workerHeartbeatSchema.safeParse(request.body);
      if (!heartbeat.success) {
        return reply.code(400).send({
          error: "Invalid worker heartbeat",
          issues: heartbeat.error.issues,
        });
      }
      return reply
        .code(202)
        .send(await repository.recordWorker(heartbeat.data));
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/internal/workers/connect",
    { websocket: true },
    (socket, request) => {
      if (
        request.headers.authorization !== `Bearer ${config.workerToken}` ||
        !request.query.workerId
      ) {
        socket.close(1008, "Unauthorized");
        return;
      }
      bridge.attach(request.query.workerId, socket);
    },
  );

  app.addHook("onClose", async () => {
    bridge.close();
    await Promise.allSettled(projectSetupTasks);
    await database.close();
  });

  return app;
}
