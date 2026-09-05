import {
  CUA_MAX_CHUNKS,
  computerUseChunkEventSchema,
  computerUseHttpResultSchema,
  computerUseRequestSchema,
  computerUseResponseSchema,
  type ComputerUseChunkEvent,
  type ComputerUseOperation,
} from "@cantrip/protocol/computer-use";
import type { FastifyInstance } from "fastify";

import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ComputerUseRouteDependencies {
  applicationOwnerId: () => string;
  serverId: string;
  repository: Pick<ServerRepository, "getChatExecutionContext">;
  bridge: Pick<WorkerCommandBus, "request">;
  authorize: (input: {
    ownerId: string;
    context: ChatExecutionContext;
    operation: ComputerUseOperation;
    operationId: string;
  }) => Promise<void>;
}

/**
 * An unregistered relay factory: production installation requires the existing
 * permission system to supply authorization first. The server never opens CUA
 * content, stores snapshots, or selects a desktop from client-provided IDs.
 */
export function installComputerUseRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    serverId,
    repository,
    bridge,
    authorize,
  }: ComputerUseRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/computer-use/operation",
    {
      bodyLimit: 128 * 1024,
      errorHandler: (error, _request, reply) =>
        reply
          .code(error.statusCode === 413 ? 413 : 400)
          .send({ error: "Invalid computer-use request." }),
    },
    async (request, reply) => {
      const input = computerUseRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({ error: "Invalid computer-use request." });
      }

      let ownerId: string;
      let context: ChatExecutionContext | null;
      try {
        ownerId = applicationOwnerId();
        context = await repository.getChatExecutionContext(
          ownerId,
          request.params.chatId,
        );
      } catch {
        return reply.code(503).send({ error: "Chat context is unavailable." });
      }
      if (!context) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      // Stopping remains available after approval is revoked. The worker must
      // authenticate the sealed action, require this exact operation, and
      // validate its session scope before closing anything.
      if (input.data.operation !== "session.close") {
        try {
          await authorize({
            ownerId,
            context,
            operation: input.data.operation,
            operationId: input.data.operationId,
          });
        } catch {
          return reply
            .code(403)
            .send({ error: "Computer use is not authorized." });
        }
      }

      const chunks: ComputerUseChunkEvent[] = [];
      let acceptingChunks = true;
      try {
        const raw = await bridge.request(
          context.workerId,
          {
            type: "computer-use.operation",
            serverId,
            chatId: context.chatId,
            executionLaneId: context.executionLaneId,
            request: input.data,
          },
          {
            ownerId,
            timeoutMs: 30_000,
            onEvent: (event) => {
              if (!acceptingChunks) return;
              const chunk = computerUseChunkEventSchema.safeParse(event);
              if (
                !chunk.success ||
                input.data.operation !== "observation.snapshot" ||
                chunk.data.operationId !== input.data.operationId ||
                chunk.data.sequence !== chunks.length ||
                chunks.length >= CUA_MAX_CHUNKS
              ) {
                throw new Error("Invalid computer-use snapshot response.");
              }
              // Strict schema bounds every ciphertext and its metadata. The
              // count limit bounds the entire opaque accumulator as well.
              chunks.push(chunk.data);
            },
          },
        );
        acceptingChunks = false;
        const response = computerUseResponseSchema.safeParse(raw);
        if (
          !response.success ||
          response.data.operationId !== input.data.operationId
        ) {
          throw new Error("Invalid computer-use response.");
        }
        // Parsing creates an independent array before the accumulator is
        // cleared. Only the client can verify the sealed image manifest.
        return reply.send(
          computerUseHttpResultSchema.parse({
            response: response.data,
            chunks,
          }),
        );
      } catch {
        return reply.code(502).send({ error: "Computer-use request failed." });
      } finally {
        acceptingChunks = false;
        chunks.length = 0;
      }
    },
  );
}
