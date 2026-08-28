import {
  chatExecutionLaneListSchema,
  chatExecutionLaneReleaseSchema,
  chatWireSummarySchema,
  chatWorktreeUpdateSchema,
  worktreeStatusResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerConflictFailure } from "../../http/worker-request-failures.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../../workers/bridge.js";

export interface ChatWorktreeAndExecutionLaneRouteDependencies {
  appendLiveChatMessage: (
    ...input: Parameters<ServerRepository["appendMessage"]>
  ) => Promise<unknown>;
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getChatExecutionLaneContext"
    | "listChatExecutionLanes"
    | "releaseChatExecutionLane"
    | "updateChatWorktree"
  >;
  requireProjectWorktrees: (projectId: string) => Promise<unknown>;
}

/** Registers Chat worktree selection and execution-lane inspection/release. */
export function installChatWorktreeAndExecutionLaneRoutes(
  app: FastifyInstance,
  {
    appendLiveChatMessage,
    applicationOwnerId,
    bridge,
    repository,
    requireProjectWorktrees,
  }: ChatWorktreeAndExecutionLaneRouteDependencies,
): void {
  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/worktree",
    async (request, reply) => {
      const input = chatWorktreeUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (context?.contextKind === "standalone") {
        return reply.code(409).send({
          error: "Standalone Chats do not have project worktrees.",
        });
      }
      if (context) await requireProjectWorktrees(context.projectId);
      try {
        const chat = await repository.updateChatWorktree(
          applicationOwnerId(),
          request.params.chatId,
          input.data,
        );
        return chat
          ? reply.send(chatWireSummarySchema.parse(chat))
          : reply.code(404).send({ error: "Chat or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/execution-lanes",
    async (request, reply) => {
      const lanes = await repository.listChatExecutionLanes(
        applicationOwnerId(),
        request.params.chatId,
      );
      return reply.send(chatExecutionLaneListSchema.parse(lanes));
    },
  );

  app.post<{ Params: { chatId: string; laneId: string } }>(
    "/api/chats/:chatId/execution-lanes/:laneId/release",
    async (request, reply) => {
      const input = chatExecutionLaneReleaseSchema.safeParse(
        request.body ?? {},
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionLaneContext(
        applicationOwnerId(),
        request.params.chatId,
        request.params.laneId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Execution lane not found." });
      }
      if (context.lane.state === "released") {
        return reply.send({
          chat: context.chat,
          lane: context.lane,
          returnedToPrimary: false,
        });
      }
      try {
        if (!bridge.isConnected(context.worktree.workerId)) {
          throw new WorkerUnavailableError("Project worker is offline.");
        }
        const status = worktreeStatusResultSchema.parse(
          await bridge.request(context.worktree.workerId, {
            type: "worktree.status",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
          }),
        );
        if (status.status.files.length > 0 && !input.data.allowDirty) {
          return reply.code(409).send({
            error:
              "This worktree has uncommitted changes. Pass allowDirty to release it intentionally.",
          });
        }
        const released = await repository.releaseChatExecutionLane(
          applicationOwnerId(),
          request.params.chatId,
          request.params.laneId,
          input.data.returnToPrimary,
        );
        if (!released) {
          return reply.code(404).send({ error: "Execution lane not found." });
        }
        await appendLiveChatMessage(
          applicationOwnerId(),
          request.params.chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: released.returnedToPrimary
                  ? `Released ${context.worktree.name}; execution returned to Primary.`
                  : `Released execution lane for ${context.worktree.name}.`,
              },
            ],
            idempotencyKey: `lane-release:${request.params.laneId}`,
          },
          {
            executionLaneId: request.params.laneId,
            worktreeId: context.worktree.id,
          },
        );
        return reply.send(released);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
