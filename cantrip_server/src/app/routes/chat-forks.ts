import { randomUUID } from "node:crypto";

import {
  chatMessageOpaqueContentListSchema,
  chatWireSummarySchema,
  encryptedChatForkSchema,
  standaloneChatWireSummarySchema,
  type ChatMessageOpaqueSummary,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatForkRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  queueStandaloneChatRootJobs: () => void;
  repository: Pick<
    ServerRepository,
    "forkChat" | "forkStandaloneChat" | "getChatExecutionContext"
  >;
}

/** Registers protected project and standalone Chat forking. */
export function installChatForkRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    queueStandaloneChatRootJobs,
    repository,
  }: ChatForkRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/fork",
    async (request, reply) => {
      const input = encryptedChatForkSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const source = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (source?.experience === "task") {
        return reply.code(409).send({
          error:
            "Encrypted Task chats must be relocated rather than forked so message row bindings remain valid.",
        });
      }
      if (!source) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (source && !bridge.isConnected(source.workerId)) {
        return reply.code(503).send({ error: "Chat worker is offline." });
      }
      try {
        const reprotect = async (messages: ChatMessageOpaqueSummary[]) => {
          const protectedMessages: unknown[] = [];
          for (let offset = 0; offset < messages.length; offset += 100) {
            protectedMessages.push(
              ...chatMessageOpaqueContentListSchema.parse(
                await bridge.request(source!.workerId, {
                  type: "chat.messages.reprotect",
                  messages: messages
                    .slice(offset, offset + 100)
                    .map((message) => ({
                      source: message,
                      id: randomUUID(),
                      idempotencyKey: `fork:${message.id}`,
                    })),
                }),
              ),
            );
          }
          return chatMessageOpaqueContentListSchema.parse(protectedMessages);
        };
        if (source?.contextKind === "standalone") {
          const created = await repository.forkStandaloneChat(
            applicationOwnerId(),
            request.params.chatId,
            input.data,
            (workerId) => bridge.isConnected(workerId),
            reprotect,
          );
          if (created) {
            publishChatSummary(created.chat.id, null);
            queueStandaloneChatRootJobs();
          }
          return created
            ? reply
                .code(202)
                .send(standaloneChatWireSummarySchema.parse(created.chat))
            : reply.code(404).send({ error: "Chat or message not found." });
        }
        const chat = await repository.forkChat(
          applicationOwnerId(),
          request.params.chatId,
          input.data,
          reprotect,
        );
        return chat
          ? reply.code(201).send(chatWireSummarySchema.parse(chat))
          : reply.code(404).send({ error: "Chat or message not found." });
      } catch (error) {
        if (/unique|duplicate/i.test(errorMessage(error))) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );
}
