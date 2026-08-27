import {
  encryptedWorkflowAutomationTriggerCreateSchema,
  encryptedWorkflowAutomationTriggerUpdateSchema,
  workflowAutomationTriggerQuerySchema,
  workflowAutomationTriggerWireListSchema,
  workflowAutomationTriggerWireSchema,
} from "@cantrip/protocol/workflows";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { WorkflowTriggerConflictError } from "../../db/workflow-triggers.js";
import { invalidBody } from "../../http/request-helpers.js";
import { requireProjectCapability } from "../../projects/capabilities.js";

export interface WorkflowTriggerManagementRouteDependencies {
  applicationOwnerId: () => string;
  publishWorkflowTriggerChange: (triggerId: string, projectId: string) => void;
  repository: ServerRepository;
}

export function installWorkflowTriggerManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishWorkflowTriggerChange,
    repository,
  }: WorkflowTriggerManagementRouteDependencies,
): void {
  app.get<{
    Querystring: {
      enabled?: string;
      limit?: string;
      projectId?: string;
      type?: string;
    };
  }>("/api/workflow-triggers", async (request, reply) => {
    const query = workflowAutomationTriggerQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    return reply.send(
      workflowAutomationTriggerWireListSchema.parse(
        await repository.workflowTriggers.list(
          applicationOwnerId(),
          query.data,
        ),
      ),
    );
  });

  app.post("/api/workflow-triggers", async (request, reply) => {
    const input = encryptedWorkflowAutomationTriggerCreateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    if (input.data.type === "git") {
      const project = await repository.getProject(
        applicationOwnerId(),
        input.data.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      requireProjectCapability(project, "git");
    }
    try {
      const trigger = await repository.workflowTriggers.create(
        applicationOwnerId(),
        input.data,
      );
      if (trigger) {
        publishWorkflowTriggerChange(trigger.id, trigger.projectId);
      }
      return trigger
        ? reply
            .code(201)
            .send(workflowAutomationTriggerWireSchema.parse(trigger))
        : reply
            .code(404)
            .send({ error: "Workflow revision or project not found." });
    } catch (error) {
      if (error instanceof WorkflowTriggerConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { triggerId: string } }>(
    "/api/workflow-triggers/:triggerId",
    async (request, reply) => {
      const input = encryptedWorkflowAutomationTriggerUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const trigger = await repository.workflowTriggers.update(
          applicationOwnerId(),
          request.params.triggerId,
          input.data,
        );
        if (trigger) {
          publishWorkflowTriggerChange(trigger.id, trigger.projectId);
        }
        return trigger
          ? reply.send(workflowAutomationTriggerWireSchema.parse(trigger))
          : reply.code(404).send({ error: "Workflow trigger not found." });
      } catch (error) {
        if (error instanceof WorkflowTriggerConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
