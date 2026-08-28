import {
  archivedChatCleanupResultSchema,
  archivedChatWireListSchema,
  archivedStandaloneChatWireSummarySchema,
  chatWireListSchema,
  chatWireSummarySchema,
  encryptedChatCreateSchema,
  encryptedStandaloneChatCreateSchema,
  standaloneChatWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ARCHIVED_CHAT_RETENTION_MS,
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
  StandaloneChatPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type {
  StandaloneChatRootJobExecutor,
  StandaloneChatRootJobLiveChange,
} from "../../standalone-chats/root-job-executor.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface StandaloneChatCatalogRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  publishChatSummary: (chatId: string, projectId: null) => void;
  repository: ServerRepository;
  standaloneChatRootJobExecutor: Pick<
    StandaloneChatRootJobExecutor,
    "queueAvailable"
  >;
}

/** Registers standalone Chat list and creation routes. */
export function installStandaloneChatCatalogRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    repository,
    standaloneChatRootJobExecutor,
  }: StandaloneChatCatalogRouteDependencies,
): void {
  app.get<{ Querystring: { context?: string } }>(
    "/api/chats",
    async (request, reply) => {
      if (request.query.context !== "standalone") {
        return reply.code(400).send({
          error: "Standalone Chat lists require context=standalone.",
        });
      }
      const chats = await repository.listStandaloneChats(applicationOwnerId());
      return reply.send(
        chats.map((chat) => standaloneChatWireSummarySchema.parse(chat)),
      );
    },
  );

  app.get<{ Querystring: { context?: string } }>(
    "/api/chats/archived",
    async (request, reply) => {
      if (request.query.context !== "standalone") {
        return reply.code(400).send({
          error: "Archived standalone Chat lists require context=standalone.",
        });
      }
      const chats =
        await repository.listArchivedStandaloneChats(applicationOwnerId());
      return reply.send(
        chats.map((chat) =>
          archivedStandaloneChatWireSummarySchema.parse(chat),
        ),
      );
    },
  );

  app.post("/api/chats", async (request, reply) => {
    const input = encryptedStandaloneChatCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const created = await repository.createStandaloneChat(
        applicationOwnerId(),
        input.data,
        (workerId) => bridge.isConnected(workerId),
      );
      publishChatSummary(created.chat.id, null);
      standaloneChatRootJobExecutor.queueAvailable();
      return reply
        .code(202)
        .send(standaloneChatWireSummarySchema.parse(created.chat));
    } catch (error) {
      if (error instanceof StandaloneChatPlacementUnavailableError) {
        return reply.code(409).send({
          code: "standalone-worker-unavailable",
          error: error.message,
        });
      }
      if (/unique|duplicate/i.test(errorMessage(error))) {
        return reply.code(409).send({ error: "Chat already exists." });
      }
      throw error;
    }
  });
}

export interface ProjectChatCatalogRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  publishStandaloneChatRootJobChange: (
    change: StandaloneChatRootJobLiveChange,
  ) => void;
  repository: ServerRepository;
  standaloneChatRootJobExecutor: Pick<
    StandaloneChatRootJobExecutor,
    "queueAvailable"
  >;
}

/** Registers project Chat catalogs, creation, and archived Chat cleanup. */
export function installProjectChatCatalogRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishStandaloneChatRootJobChange,
    repository,
    standaloneChatRootJobExecutor,
  }: ProjectChatCatalogRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const chats = await repository.listChats(
        applicationOwnerId(),
        request.params.projectId,
      );
      return reply.send(chatWireListSchema.parse(chats));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/archived-chats",
    async (request, reply) => {
      const chats = await repository.listArchivedChats(
        applicationOwnerId(),
        request.params.projectId,
      );
      return reply.send(archivedChatWireListSchema.parse(chats));
    },
  );

  app.post("/api/chats/archives/cleanup", async (_request, reply) => {
    const ownerId = applicationOwnerId();
    const deleted = await repository.purgeExpiredArchivedChats(
      ownerId,
      new Date(Date.now() - ARCHIVED_CHAT_RETENTION_MS),
    );
    const standaloneJobs =
      await repository.standaloneChatRootJobs.purgeExpiredArchivedChats(
        ownerId,
      );
    for (const job of standaloneJobs) {
      publishStandaloneChatRootJobChange({ ownerId, job });
    }
    if (standaloneJobs.length > 0) {
      standaloneChatRootJobExecutor.queueAvailable();
    }
    return reply.send(
      archivedChatCleanupResultSchema.parse({
        deleted: deleted + standaloneJobs.length,
      }),
    );
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const input = encryptedChatCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const chat = await repository.createChat(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => bridge.isConnected(workerId),
        );
        if (!chat) {
          return reply.code(404).send({ error: "Project source not found" });
        }
        return reply.code(201).send(chatWireSummarySchema.parse(chat));
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          if (error.code === "project-not-found") {
            return reply.code(404).send({ error: "Project source not found" });
          }
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        if (
          error instanceof ExecutionLaneConflictError ||
          /unique|duplicate/i.test(errorMessage(error))
        ) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );
}
