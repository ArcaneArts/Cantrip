import {
  fileDocumentCreateSchema,
  fileDocumentWireListSchema,
  fileDocumentWireSummarySchema,
  surfaceStreamWireRequestSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { FileDocumentConflictError } from "../../db/repository/file-documents.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface FileDocumentRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "fileDocuments">;
}

export function installFileDocumentOperationRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    bridge,
    serverId,
  }: FileDocumentRouteDependencies & {
    bridge: Pick<WorkerCommandBus, "request">;
    serverId: string;
  },
) {
  app.post<{ Params: { documentId: string } }>(
    "/api/file-documents/:documentId/operation",
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const input = surfaceStreamWireRequestSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const context = await repository.fileDocuments.executionContext(
        applicationOwnerId(),
        request.params.documentId,
      );
      if (!context)
        return reply
          .code(404)
          .send({ error: "File document checkout is unavailable." });
      try {
        const result = await bridge.request(context.workerId, {
          type: "file-document.operation",
          documentId: context.id,
          serverId,
          projectId: context.projectId,
          workerId: context.workerId,
          worktreeId: context.worktreeId,
          root: context.root,
          stateProtection: context.stateProtection,
          ...input.data,
        });
        return reply.send(surfaceStreamWireResponseSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}

export function installFileDocumentRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: FileDocumentRouteDependencies,
) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/file-documents",
    async (request, reply) =>
      reply.send(
        fileDocumentWireListSchema.parse(
          await repository.fileDocuments.list(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );
  app.get<{ Params: { documentId: string } }>(
    "/api/file-documents/:documentId",
    async (request, reply) => {
      const document = await repository.fileDocuments.get(
        applicationOwnerId(),
        request.params.documentId,
      );
      return document
        ? reply.send(fileDocumentWireSummarySchema.parse(document))
        : reply.code(404).send({ error: "File document not found." });
    },
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/file-documents",
    async (request, reply) => {
      const input = fileDocumentCreateSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const document = await repository.fileDocuments.create(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return document
          ? reply.send(fileDocumentWireSummarySchema.parse(document))
          : reply
              .code(404)
              .send({ error: "Project or available worktree not found." });
      } catch (error) {
        if (error instanceof FileDocumentConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
