import {
  encryptedWorkflowDefinitionCreateSchema,
  encryptedWorkflowDefinitionUpdateSchema,
  encryptedWorkflowRevisionCreateSchema,
  workflowDefinitionQuerySchema,
  workflowDefinitionWireDetailSchema,
  workflowDefinitionWireListSchema,
  workflowDefinitionWireSummarySchema,
  workflowRevisionWireListSchema,
  workflowRevisionWireSchema,
} from "@cantrip/protocol/workflows";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { WorkflowConflictError } from "../../db/workflows.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface WorkflowDefinitionRouteDependencies {
  applicationOwnerId: () => string;
  publishWorkflowDefinitionChange: (workflowId: string) => void;
  repository: ServerRepository;
}

export function installWorkflowDefinitionRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishWorkflowDefinitionChange,
    repository,
  }: WorkflowDefinitionRouteDependencies,
): void {
  app.get<{
    Querystring: {
      includeArchived?: string;
      limit?: string;
      projectId?: string;
      scope?: string;
    };
  }>("/api/workflows", async (request, reply) => {
    const query = workflowDefinitionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    return reply.send(
      workflowDefinitionWireListSchema.parse(
        await repository.workflows.listDefinitions(
          applicationOwnerId(),
          query.data,
        ),
      ),
    );
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/workflow-repository",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow repository scan path was removed pending the protected worker relay.",
      }),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/workflow-repository/import",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow repository import path was removed pending the protected worker relay.",
      }),
  );

  app.post("/api/workflows", async (request, reply) => {
    const input = encryptedWorkflowDefinitionCreateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const workflow = await repository.workflows.createDefinition(
        applicationOwnerId(),
        input.data,
      );
      if (workflow) {
        publishWorkflowDefinitionChange(workflow.workflow.id);
      }
      return workflow
        ? reply
            .code(201)
            .send(workflowDefinitionWireDetailSchema.parse(workflow))
        : reply.code(404).send({ error: "Project not found." });
    } catch (error) {
      if (error instanceof WorkflowConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId",
    async (request, reply) => {
      const workflow = await repository.workflows.getDefinition(
        applicationOwnerId(),
        request.params.workflowId,
      );
      return workflow
        ? reply.send(workflowDefinitionWireDetailSchema.parse(workflow))
        : reply.code(404).send({ error: "Workflow not found." });
    },
  );

  app.post<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/repository-export",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow repository export path was removed pending the protected worker relay.",
      }),
  );

  app.patch<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId",
    async (request, reply) => {
      const input = encryptedWorkflowDefinitionUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const workflow = await repository.workflows.updateDefinition(
        applicationOwnerId(),
        request.params.workflowId,
        input.data,
      );
      if (workflow) {
        publishWorkflowDefinitionChange(workflow.id);
      }
      return workflow
        ? reply.send(workflowDefinitionWireSummarySchema.parse(workflow))
        : reply.code(404).send({ error: "Workflow not found." });
    },
  );

  app.get<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/revisions",
    async (request, reply) => {
      const revisions = await repository.workflows.listRevisions(
        applicationOwnerId(),
        request.params.workflowId,
      );
      return revisions
        ? reply.send(workflowRevisionWireListSchema.parse(revisions))
        : reply.code(404).send({ error: "Workflow not found." });
    },
  );

  app.post<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/revisions",
    async (request, reply) => {
      const input = encryptedWorkflowRevisionCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const revision = await repository.workflows.appendRevision(
          applicationOwnerId(),
          request.params.workflowId,
          input.data,
        );
        if (revision) {
          publishWorkflowDefinitionChange(revision.workflowId);
        }
        return revision
          ? reply.send(workflowRevisionWireSchema.parse(revision))
          : reply.code(404).send({ error: "Workflow not found." });
      } catch (error) {
        if (error instanceof WorkflowConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { revision: string; workflowId: string } }>(
    "/api/workflows/:workflowId/revisions/:revision",
    async (request, reply) => {
      const revisionNumber = Number(request.params.revision);
      if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
        return reply.code(400).send({ error: "Invalid workflow revision." });
      }
      const revision = await repository.workflows.getRevision(
        applicationOwnerId(),
        request.params.workflowId,
        revisionNumber,
      );
      return revision
        ? reply.send(workflowRevisionWireSchema.parse(revision))
        : reply.code(404).send({ error: "Workflow revision not found." });
    },
  );
}
