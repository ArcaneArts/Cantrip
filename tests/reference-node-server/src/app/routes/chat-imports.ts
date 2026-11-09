import {
  chatImportCreateSchema,
  chatImportJobListSchema,
  chatImportJobRetrySchema,
  chatImportJobSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type {
  ChatImportJobExecutor,
  ChatImportLiveChange,
} from "../../chat-imports/executor.js";
import {
  ChatImportJobConflictError,
  ChatImportJobNotFoundError,
} from "../../db/chat-import-jobs.js";
import {
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatImportRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected">;
  chatImportJobExecutor: Pick<ChatImportJobExecutor, "queueAvailable">;
  publishChatImportChange: (change: ChatImportLiveChange) => void;
  repository: Pick<
    ServerRepository,
    "chatImportJobs" | "resolveProjectExecutionPlacement"
  >;
}

/** Registers project chat-import creation, inspection, and retry routes. */
export function installChatImportRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    chatImportJobExecutor,
    publishChatImportChange,
    repository,
  }: ChatImportRouteDependencies,
): void {
  app.post<{
    Params: { projectId: string };
    Body: unknown;
  }>("/api/projects/:projectId/chat-imports", async (request, reply) => {
    const ownerId = applicationOwnerId();
    const input = chatImportCreateSchema.parse(request.body);
    try {
      const prepared = await Promise.all(
        input.imports.map(async (selection) => {
          const { placement } =
            await repository.resolveProjectExecutionPlacement(
              ownerId,
              request.params.projectId,
              "chat",
              selection.target,
              (workerId) => bridge.isConnected(workerId),
            );
          return { selection, placement };
        }),
      );
      const jobs = [];
      for (const { selection, placement } of prepared) {
        jobs.push(
          await repository.chatImportJobs.create(
            ownerId,
            request.params.projectId,
            {
              sourceKind: selection.sourceKind,
              sourceWorkerId: selection.sourceWorkerId,
              sourceId: selection.sourceId,
              sourceThreadId: selection.sourceThreadId,
              targetPlacement: placement,
              modelId: selection.modelId,
              modelRouteId: selection.modelRouteId,
              providerAccountId: selection.providerAccountId,
              permissionProfileId: selection.permissionProfileId,
              planMode: selection.planMode,
              idempotencyKey: selection.idempotencyKey,
            },
          ),
        );
      }
      for (const job of jobs) {
        publishChatImportChange({ ownerId, job });
      }
      app.log.info(
        {
          chatImportJobIds: jobs.map(({ id }) => id),
          importCount: jobs.length,
          projectId: request.params.projectId,
          sourceWorkerIds: [
            ...new Set(jobs.map(({ sourceWorkerId }) => sourceWorkerId)),
          ],
          targetWorkerIds: [
            ...new Set(
              jobs.map(({ targetPlacement }) => targetPlacement.workerId),
            ),
          ],
        },
        "Chat imports created",
      );
      chatImportJobExecutor.queueAvailable();
      return reply.code(202).send(chatImportJobListSchema.parse(jobs));
    } catch (error) {
      if (error instanceof ChatImportJobNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (
        error instanceof ChatImportJobConflictError ||
        error instanceof ExecutionPlacementUnavailableError
      ) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chat-imports",
    async (request, reply) => {
      const jobs = await repository.chatImportJobs.list(
        applicationOwnerId(),
        request.params.projectId,
      );
      return jobs
        ? reply.send(chatImportJobListSchema.parse(jobs))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/chat-imports/:jobId",
    async (request, reply) => {
      const job = await repository.chatImportJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      return job
        ? reply.send(chatImportJobSummarySchema.parse(job))
        : reply.code(404).send({ error: "Chat import not found." });
    },
  );

  app.post<{ Params: { jobId: string }; Body: unknown }>(
    "/api/chat-imports/:jobId/retry",
    async (request, reply) => {
      const input = chatImportJobRetrySchema.parse(request.body);
      const job = await repository.chatImportJobs.retry(
        applicationOwnerId(),
        request.params.jobId,
        input.stateRevision,
      );
      if (!job) {
        return reply.code(409).send({
          error:
            "The import changed or cannot be retried in its current state.",
        });
      }
      publishChatImportChange({ ownerId: applicationOwnerId(), job });
      chatImportJobExecutor.queueAvailable();
      return reply.send(chatImportJobSummarySchema.parse(job));
    },
  );
}
