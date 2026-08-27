import {
  runConfigurationSecretListResultSchema,
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { AppendAudit } from "../http/audit.js";

export interface RunConfigurationSecretRouteDependencies {
  appendAudit: AppendAudit;
  applicationOwnerId: () => string;
  publishRunConfigurationInvalidation: (projectId: string) => void;
  repository: ServerRepository;
  sendRunApiFailure: (reply: FastifyReply, error: unknown) => FastifyReply;
}

export function installRunConfigurationSecretRoutes(
  app: FastifyInstance,
  {
    appendAudit,
    applicationOwnerId,
    publishRunConfigurationInvalidation,
    repository,
    sendRunApiFailure,
  }: RunConfigurationSecretRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/run-configuration-secrets",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      if (!(await repository.getProject(ownerId, request.params.projectId))) {
        return reply.code(404).send({ error: "Project not found." });
      }
      return reply.send(
        runConfigurationSecretListResultSchema.parse({
          projectId: request.params.projectId,
          secrets: await repository.listRunConfigurationSecretSummaries(
            ownerId,
            request.params.projectId,
          ),
        }),
      );
    },
  );

  app.put<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/run-configuration-secrets",
    async (request, reply) => {
      const input = runConfigurationSecretSetRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      if (!(await repository.getProject(ownerId, request.params.projectId))) {
        return reply.code(404).send({ error: "Project not found." });
      }
      try {
        const result = runConfigurationSecretSetResultSchema.parse(
          await repository.setRunConfigurationSecret(
            ownerId,
            request.params.projectId,
            input.data,
          ),
        );
        publishRunConfigurationInvalidation(request.params.projectId);
        await appendAudit(request, {
          action: "run.configuration.secret.app.set",
          resourceId: input.data.reference,
          resourceType: "run-configuration-secret",
          result: "succeeded",
        });
        return reply
          .code(!result.replayed && result.secret.revision === 1 ? 201 : 200)
          .send(result);
      } catch (error) {
        return sendRunApiFailure(reply, error);
      }
    },
  );
}
