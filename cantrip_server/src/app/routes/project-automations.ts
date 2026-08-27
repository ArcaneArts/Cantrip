import {
  encryptedProjectAutomationCreateSchema,
  encryptedProjectAutomationUpdateSchema,
  projectAutomationWireListSchema,
  projectAutomationWireSchema,
} from "@cantrip/protocol/automations";
import type { FastifyInstance } from "fastify";

import { ProjectAutomationConflictError } from "../../db/project-automations.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface ProjectAutomationRouteDependencies {
  applicationOwnerId: () => string;
  publishProjectAutomationChange: (
    projectId: string,
    automationId: string,
  ) => void;
  repository: ServerRepository;
}

export function installProjectAutomationRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    publishProjectAutomationChange,
    repository,
  }: ProjectAutomationRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/automations",
    async (request, reply) =>
      reply.send(
        projectAutomationWireListSchema.parse(
          await repository.projectAutomations.list(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/automations",
    async (request, reply) => {
      const input = encryptedProjectAutomationCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const automation = await repository.projectAutomations.create(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        if (!automation) {
          return reply
            .code(404)
            .send({ error: "Project or target chat not found." });
        }
        publishProjectAutomationChange(automation.projectId, automation.id);
        return reply
          .code(201)
          .send(projectAutomationWireSchema.parse(automation));
      } catch (error) {
        if (error instanceof ProjectAutomationConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { automationId: string } }>(
    "/api/automations/:automationId",
    async (request, reply) => {
      const input = encryptedProjectAutomationUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const automation = await repository.projectAutomations.update(
          applicationOwnerId(),
          request.params.automationId,
          input.data,
        );
        if (!automation) {
          return reply.code(404).send({ error: "Automation not found." });
        }
        publishProjectAutomationChange(automation.projectId, automation.id);
        return reply.send(projectAutomationWireSchema.parse(automation));
      } catch (error) {
        if (error instanceof ProjectAutomationConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { automationId: string } }>(
    "/api/automations/:automationId",
    async (request, reply) => {
      const automation = await repository.projectAutomations.get(
        applicationOwnerId(),
        request.params.automationId,
      );
      if (
        !automation ||
        !(await repository.projectAutomations.delete(
          applicationOwnerId(),
          request.params.automationId,
        ))
      ) {
        return reply.code(404).send({ error: "Automation not found." });
      }
      publishProjectAutomationChange(automation.projectId, automation.id);
      return reply.code(204).send();
    },
  );
}
