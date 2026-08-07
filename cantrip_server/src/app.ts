import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  agentTurnResultSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatCreateSchema,
  chatForkSchema,
  chatListSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatModelUpdateSchema,
  chatSummarySchema,
  chatTurnAcceptedSchema,
  chatTurnCreateSchema,
  chatUpdateSchema,
  githubAuthStatusSchema,
  githubProjectCreateSchema,
  githubRepositoryListSchema,
  githubWorkerRepositoryListSchema,
  gitHistorySchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderCreateSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  orderedIdsSchema,
  projectCloneResultSchema,
  projectListSchema,
  projectRemoveSchema,
  projectSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
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
import type { ChatMessage } from "@cantrip/protocol";

import type { ServerConfig } from "./config.js";
import type { DatabaseConnection } from "./db/index.js";
import { LOCAL_USER_ID } from "./db/repository.js";
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

  app.get("/api/workers", { logLevel: "warn" }, async (_request, reply) => {
    const workers = await repository.listWorkers(LOCAL_USER_ID);
    return reply.send(workerListSchema.parse(workers));
  });

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/codex/auth/status",
    async (request, reply) => {
      if (!request.query.workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const status = codexAuthStatusSchema.parse(
          await bridge.request(request.query.workerId, {
            type: "codex.auth.status",
          }),
        );
        if (status.authMode === "chatgpt") {
          await repository.ensureChatGptProvider(LOCAL_USER_ID);
        }
        return reply.send(status);
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: { workerId?: string } }>(
    "/api/codex/auth/device-login",
    async (request, reply) => {
      if (!request.body?.workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        return reply.send(
          codexDeviceLoginSchema.parse(
            await bridge.request(request.body.workerId, {
              type: "codex.auth.login.start",
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

  app.post<{ Body: { workerId?: string } }>(
    "/api/codex/auth/logout",
    async (request, reply) => {
      if (!request.body?.workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        await bridge.request(request.body.workerId, {
          type: "codex.auth.logout",
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

      try {
        if (input.data.deleteLocalFiles) {
          await Promise.all(
            context.terminalIds.map((terminalId) =>
              bridge.request(context.workerId, {
                type: "terminal.close",
                terminalId,
              }),
            ),
          );
          await bridge.request(context.workerId, {
            type: "project.files.delete",
            path: context.cwd,
          });
        } else if (bridge.isConnected(context.workerId)) {
          for (const terminalId of context.terminalIds) {
            void bridge
              .request(context.workerId, {
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
      const available = githubWorkerRepositoryListSchema.parse(
        await bridge.request(input.data.workerId, {
          type: "github.repositories.list",
        }),
      );
      const githubRepository = available.find(
        (candidate) =>
          candidate.id === input.data.repositoryId &&
          candidate.nameWithOwner === input.data.nameWithOwner &&
          candidate.url === input.data.url,
      );
      if (!githubRepository) {
        return reply
          .code(404)
          .send({ error: "Repository is not available on this worker." });
      }

      const clone = projectCloneResultSchema.parse(
        await bridge.request(input.data.workerId, {
          type: "project.clone",
          repository: { nameWithOwner: githubRepository.nameWithOwner },
        }),
      );
      const project = await repository.createGithubProject(
        LOCAL_USER_ID,
        input.data,
        clone,
      );
      return reply.code(201).send(projectSummarySchema.parse(project));
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
        await repository.setTerminalStatus(terminalId, "running");
        if (closed) {
          await repository.setTerminalStatus(terminalId, "idle");
          return;
        }
        send({ type: "ready" });
        try {
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
              },
              {
                timeoutMs: null,
                onEvent: (event) => {
                  if (event.type === "terminal.output") {
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
          chatTurnAcceptedSchema.parse({ accepted: true, message: existing }),
        );
      }
      if (context.status === "running") {
        return reply.code(409).send({ error: "A turn is already running." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }

      const defaultModelId = context.modelId
        ? null
        : (await repository.getSettings(LOCAL_USER_ID)).preferences
            .defaultModelId;
      const modelId = input.data.modelId ?? context.modelId ?? defaultModelId;
      if (!modelId) {
        return reply.code(409).send({
          error: "Choose a model or configure a default model in Settings.",
        });
      }
      const runtime = await repository.getModelRuntime(LOCAL_USER_ID, modelId);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const priorMessages = context.threadId
        ? []
        : await repository.listMessages(LOCAL_USER_ID, context.chatId);
      const workerPrompt = continuationPrompt(priorMessages, input.data.text);

      const userMessage = await repository.appendMessage(
        LOCAL_USER_ID,
        context.chatId,
        {
          role: "user",
          content: [{ type: "text", text: input.data.text }],
          idempotencyKey: input.data.idempotencyKey,
        },
      );
      if (!userMessage) {
        return reply.code(404).send({ error: "Chat not found" });
      }
      await repository.setChatModel(LOCAL_USER_ID, context.chatId, { modelId });
      await repository.setChatStatus(context.chatId, "running");

      void bridge
        .request(
          context.workerId,
          {
            type: "chat.turn",
            chatId: context.chatId,
            cwd: context.cwd,
            threadId: context.threadId,
            prompt: workerPrompt,
            model: runtime.model,
            provider: runtime.provider,
          },
          {
            onEvent: async (event) => {
              if (event.type !== "agent.activity") {
                return;
              }
              await repository.upsertMessage(LOCAL_USER_ID, context.chatId, {
                role: "assistant",
                content: [{ type: "activity", activity: event.activity }],
                idempotencyKey: `activity:${userMessage.id}:${event.activity.id}`,
              });
            },
          },
        )
        .then(async (rawResult) => {
          const result = agentTurnResultSchema.parse(rawResult);
          await repository.updateChatRuntime(
            context.chatId,
            context.workerId,
            result.threadId,
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
        })
        .catch(async (error: unknown) => {
          app.log.error(
            { chatId: context.chatId, err: error },
            "Agent turn failed",
          );
          await repository.appendMessage(LOCAL_USER_ID, context.chatId, {
            role: "system",
            content: [
              { type: "text", text: `Agent failed: ${errorMessage(error)}` },
            ],
            idempotencyKey: `error:${userMessage.id}`,
          });
          await repository.setChatStatus(context.chatId, "failed");
        });

      return reply.code(202).send(
        chatTurnAcceptedSchema.parse({
          accepted: true,
          message: userMessage,
        }),
      );
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
    await database.close();
  });

  return app;
}
