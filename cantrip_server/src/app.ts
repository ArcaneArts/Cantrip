import cors from "@fastify/cors";
import {
  chatCreateSchema,
  chatListSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatSummarySchema,
  projectCreateSchema,
  projectListSchema,
  projectSummarySchema,
  serverBootstrapSchema,
  systemHealthSchema,
  workerHeartbeatSchema,
  workerListSchema,
} from "@cantrip/protocol";
import Fastify from "fastify";

import type { ServerConfig } from "./config.js";
import type { DatabaseConnection } from "./db/index.js";
import { LOCAL_USER_ID } from "./db/repository.js";

export interface BuildAppOptions {
  config: ServerConfig;
  database: DatabaseConnection;
  logger?: boolean;
}

function invalidBody(issues: unknown) {
  return { error: "Invalid request body", issues };
}

export async function buildApp({
  config,
  database,
  logger = true,
}: BuildAppOptions) {
  const app = Fastify({ logger });
  const repository = database.repository;
  const [serverId, currentUser] = await Promise.all([
    repository.getOrCreateServerId(),
    repository.ensureLocalIdentity(),
  ]);

  await app.register(cors, {
    credentials: true,
    origin: config.appOrigins,
  });

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
    const health = systemHealthSchema.parse({
      status: "ok",
      service: "cantrip_server",
      database: {
        engine: database.engine,
        ready: true,
      },
      workers: {
        connected: await repository.onlineWorkerCount(LOCAL_USER_ID),
      },
      timestamp: new Date().toISOString(),
    });

    return reply.send(health);
  });

  app.get("/api/workers", { logLevel: "warn" }, async (_request, reply) => {
    const workers = await repository.listWorkers(LOCAL_USER_ID);
    return reply.send(workerListSchema.parse(workers));
  });

  app.get("/api/projects", async (_request, reply) => {
    const projects = await repository.listProjects(LOCAL_USER_ID);
    return reply.send(projectListSchema.parse(projects));
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }

    const project = await repository.createProject(LOCAL_USER_ID, input.data);
    return reply.code(201).send(projectSummarySchema.parse(project));
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
        return reply.code(404).send({ error: "Project or worker not found" });
      }
      return reply.code(201).send(chatSummarySchema.parse(chat));
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

  app.addHook("onClose", async () => {
    await database.close();
  });

  return app;
}
