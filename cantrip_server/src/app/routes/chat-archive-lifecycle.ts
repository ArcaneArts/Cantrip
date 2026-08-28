import { randomUUID } from "node:crypto";

import {
  chatWireSummarySchema,
  standaloneChatScratchArchiveResultSchema,
  standaloneChatWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatArchiveLifecycleRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  queueStandaloneChatRootJobs: () => void;
  repository: Pick<
    ServerRepository,
    | "archiveStandaloneChat"
    | "deleteChat"
    | "getChatExecutionContext"
    | "getStandaloneChatRootForDeletion"
    | "permanentlyDeleteArchivedChat"
    | "restoreArchivedChat"
    | "restoreStandaloneChat"
  > & {
    standaloneChatRootJobs: Pick<
      ServerRepository["standaloneChatRootJobs"],
      "createDeletionTombstoneAndPurge"
    >;
  };
  revokeManagedFileShare: (
    ownerId: string,
    managedResourceId: string,
  ) => Promise<boolean>;
}

/** Registers active Chat archival, restoration, and permanent deletion. */
export function installChatArchiveLifecycleRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    queueStandaloneChatRootJobs,
    repository,
    revokeManagedFileShare,
  }: ChatArchiveLifecycleRouteDependencies,
): void {
  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (context?.contextKind === "standalone") {
        const archived = await repository.archiveStandaloneChat(
          applicationOwnerId(),
          request.params.chatId,
        );
        if (archived === "running") {
          return reply
            .code(409)
            .send({ error: "Stop the running Chat first." });
        }
        if (!archived) {
          return reply.code(404).send({ error: "Chat not found." });
        }
        if (bridge.isConnected(archived.workerId)) {
          try {
            standaloneChatScratchArchiveResultSchema.parse(
              await bridge.request(archived.workerId, {
                type: "chat.scratch.archive",
                rootId: archived.rootId,
                chatId: request.params.chatId,
                archivedAt: archived.archivedAt,
                archiveExpiresAt: archived.archiveExpiresAt,
              }),
            );
          } catch (error) {
            request.log.warn(
              { chatId: request.params.chatId, err: error },
              "Standalone Chat scratch archive will be reconciled later",
            );
          }
        }
        await revokeManagedFileShare(
          applicationOwnerId(),
          `chat:${request.params.chatId}`,
        ).catch((error) => {
          request.log.warn(
            { chatId: request.params.chatId, err: error },
            "Standalone Chat scratch share revocation will expire naturally",
          );
        });
        publishChatSummary(request.params.chatId, null);
        return reply.code(204).send();
      }
      const result = await repository.deleteChat(
        applicationOwnerId(),
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
    "/api/chats/:chatId/restore",
    async (request, reply) => {
      const standalone = await repository.restoreStandaloneChat(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (standalone) {
        if (bridge.isConnected(standalone.workerId)) {
          try {
            standaloneChatScratchArchiveResultSchema.parse(
              await bridge.request(standalone.workerId, {
                type: "chat.scratch.restore",
                rootId: standalone.rootId,
                chatId: request.params.chatId,
              }),
            );
          } catch (error) {
            request.log.warn(
              { chatId: request.params.chatId, err: error },
              "Standalone Chat scratch restore will be reconciled later",
            );
          }
        }
        publishChatSummary(request.params.chatId, null);
        return reply.send(
          standaloneChatWireSummarySchema.parse(standalone.chat),
        );
      }
      const chat = await repository.restoreArchivedChat(
        applicationOwnerId(),
        request.params.chatId,
      );
      return chat
        ? reply.send(chatWireSummarySchema.parse(chat))
        : reply.code(404).send({ error: "Archived chat not found." });
    },
  );

  app.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/permanent",
    async (request, reply) => {
      const root = await repository.getStandaloneChatRootForDeletion(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (root) {
        await revokeManagedFileShare(
          applicationOwnerId(),
          `chat:${request.params.chatId}`,
        ).catch((error) => {
          request.log.warn(
            { chatId: request.params.chatId, err: error },
            "Standalone Chat scratch share revocation will expire naturally",
          );
        });
        await repository.standaloneChatRootJobs.createDeletionTombstoneAndPurge(
          { id: randomUUID(), ...root },
        );
        publishChatSummary(request.params.chatId, null);
        queueStandaloneChatRootJobs();
        return reply.code(204).send();
      }
      const deleted = await repository.permanentlyDeleteArchivedChat(
        applicationOwnerId(),
        request.params.chatId,
      );
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Archived chat not found." });
    },
  );
}
