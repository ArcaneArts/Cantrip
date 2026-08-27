import {
  chatRelocationCreateSchema,
  chatRelocationJobCancelSchema,
  chatRelocationJobListSchema,
  chatRelocationJobRetrySchema,
  chatRelocationJobSummarySchema,
  type ChatRelocationJobSummary,
  type ProjectWireSummary,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ChatRelocationJobConflictError,
  ChatRelocationJobNotFoundError,
} from "../../db/chat-relocation-jobs.js";
import {
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";

type RelocationJobsRepository = Pick<
  ServerRepository["chatRelocationJobs"],
  "cancel" | "create" | "get" | "list" | "retry"
>;

type ChatRelocationRouteRepository = Pick<
  ServerRepository,
  "getChatExecutionContext" | "getWorker" | "resolveProjectExecutionPlacement"
> & {
  chatRelocationJobs: RelocationJobsRepository;
};

export interface ChatRelocationRouteDependencies {
  applicationOwnerId: () => string;
  isWorkerConnected: (workerId: string) => boolean;
  publishChatRelocationChange: (change: {
    ownerId: string;
    job: ChatRelocationJobSummary;
  }) => void;
  queueChatRelocationJobs: () => void;
  repository: ChatRelocationRouteRepository;
  requireProjectRelocation: (
    projectId: string,
  ) => Promise<ProjectWireSummary | null>;
}

export function installChatRelocationRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    isWorkerConnected,
    publishChatRelocationChange,
    queueChatRelocationJobs,
    repository,
    requireProjectRelocation,
  }: ChatRelocationRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/relocations",
    async (request, reply) => {
      const input = chatRelocationCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getChatExecutionContext(
        ownerId,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (context.contextKind !== "project") {
        return reply.code(409).send({
          error: "Standalone Chats do not support durable project relocation.",
        });
      }
      const project = await requireProjectRelocation(context.projectId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      try {
        const resolution = await repository.resolveProjectExecutionPlacement(
          ownerId,
          context.projectId,
          "chat",
          input.data.target,
          (workerId) => isWorkerConnected(workerId),
          true,
        );
        const [sourceWorker, targetWorker] = await Promise.all([
          repository.getWorker(ownerId, context.workerId),
          repository.getWorker(ownerId, resolution.placement.workerId),
        ]);
        if (!sourceWorker?.chatRelocation || !targetWorker?.chatRelocation) {
          return reply.code(409).send({
            error:
              "Both workers must be upgraded to a version that supports durable chat relocation.",
          });
        }
        const job = await repository.chatRelocationJobs.create(
          ownerId,
          context.chatId,
          resolution.placement,
          input.data.idempotencyKey,
        );
        publishChatRelocationChange({ ownerId, job });
        queueChatRelocationJobs();
        return reply.code(202).send(chatRelocationJobSummarySchema.parse(job));
      } catch (error) {
        if (
          error instanceof ChatRelocationJobNotFoundError ||
          (error instanceof ExecutionPlacementUnavailableError &&
            error.code === "project-not-found")
        ) {
          return reply.code(404).send({ error: error.message });
        }
        if (
          error instanceof ChatRelocationJobConflictError ||
          error instanceof ExecutionPlacementUnavailableError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/relocations",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const context = await repository.getChatExecutionContext(
        ownerId,
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      if (context.contextKind !== "project") {
        return reply.code(409).send({
          error: "Standalone Chats do not support durable project relocation.",
        });
      }
      await requireProjectRelocation(context.projectId);
      return reply.send(
        chatRelocationJobListSchema.parse(
          await repository.chatRelocationJobs.list(
            ownerId,
            request.params.chatId,
          ),
        ),
      );
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/chat-relocations/:jobId",
    async (request, reply) => {
      const job = await repository.chatRelocationJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      if (job) await requireProjectRelocation(job.projectId);
      return job
        ? reply.send(chatRelocationJobSummarySchema.parse(job))
        : reply.code(404).send({ error: "Chat relocation not found." });
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/api/chat-relocations/:jobId/retry",
    async (request, reply) => {
      const input = chatRelocationJobRetrySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const existing = await repository.chatRelocationJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      if (existing) await requireProjectRelocation(existing.projectId);
      try {
        const job = await repository.chatRelocationJobs.retry(
          applicationOwnerId(),
          request.params.jobId,
          input.data.stateRevision,
        );
        publishChatRelocationChange({
          ownerId: applicationOwnerId(),
          job,
        });
        queueChatRelocationJobs();
        return reply.send(chatRelocationJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ChatRelocationJobNotFoundError) {
          return reply.code(404).send({ error: "Chat relocation not found." });
        }
        if (error instanceof ChatRelocationJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/api/chat-relocations/:jobId/cancel",
    async (request, reply) => {
      const input = chatRelocationJobCancelSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const existing = await repository.chatRelocationJobs.get(
        applicationOwnerId(),
        request.params.jobId,
      );
      if (existing) await requireProjectRelocation(existing.projectId);
      try {
        const job = await repository.chatRelocationJobs.cancel(
          applicationOwnerId(),
          request.params.jobId,
          input.data.stateRevision,
        );
        publishChatRelocationChange({
          ownerId: applicationOwnerId(),
          job,
        });
        return reply.send(chatRelocationJobSummarySchema.parse(job));
      } catch (error) {
        if (error instanceof ChatRelocationJobNotFoundError) {
          return reply.code(404).send({ error: "Chat relocation not found." });
        }
        if (error instanceof ChatRelocationJobConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
