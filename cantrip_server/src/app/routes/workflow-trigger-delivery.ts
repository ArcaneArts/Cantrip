import {
  encryptedWorkflowGitEventDeliveryCreateSchema,
  encryptedWorkflowTriggerDeliveryCreateSchema,
  workflowTriggerDeliveryWireResultSchema,
  workflowWebhookDeliveryCreateSchema,
} from "@cantrip/protocol/workflows";
import type { WorkflowContentOpaque } from "@cantrip/protocol/workflow-content";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { WorkflowRunConflictError } from "../../db/workflow-runs.js";
import {
  WorkflowTriggerConflictError,
  WorkflowTriggerRateLimitError,
} from "../../db/workflow-triggers.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { requireProjectCapability } from "../../projects/capabilities.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import { safeCredentialMatch } from "../../workflows/trigger-helpers.js";

export interface WorkflowTriggerRouteDeliveryInput {
  actorId: string | null;
  actorType: "user" | "api" | "webhook" | "git";
  allowOfflineQueue: false;
  allowedType: "api" | "webhook" | "git" | "saved-command";
  idempotencyKey: string;
  protectedPayload: WorkflowContentOpaque | null;
  triggerId: string;
}

export interface WorkflowTriggerDeliveryRouteDependencies {
  applicationOwnerId: () => string;
  deliverWorkflowTrigger: (
    input: WorkflowTriggerRouteDeliveryInput,
  ) => Promise<{ replayed: boolean }>;
  repository: ServerRepository;
  runAsOwner: <T>(ownerId: string, operation: () => T) => T;
}

export function installWorkflowTriggerDeliveryRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    deliverWorkflowTrigger,
    repository,
    runAsOwner,
  }: WorkflowTriggerDeliveryRouteDependencies,
): void {
  app.post<{ Params: { triggerId: string } }>(
    "/api/workflow-triggers/:triggerId/deliver",
    async (request, reply) => {
      const input = encryptedWorkflowTriggerDeliveryCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await deliverWorkflowTrigger({
          actorId: applicationOwnerId(),
          actorType: "api",
          allowOfflineQueue: false,
          allowedType: "api",
          idempotencyKey: input.data.idempotencyKey,
          protectedPayload: input.data.protectedPayload,
          triggerId: request.params.triggerId,
        });
        return reply
          .code(result.replayed ? 200 : 201)
          .send(workflowTriggerDeliveryWireResultSchema.parse(result));
      } catch (error) {
        if (error instanceof WorkflowTriggerRateLimitError) {
          return reply
            .header("retry-after", String(error.retryAfterSeconds))
            .code(429)
            .send({ error: error.message });
        }
        const status =
          error instanceof WorkerUnavailableError
            ? 503
            : error instanceof WorkflowTriggerConflictError ||
                error instanceof WorkflowRunConflictError
              ? 409
              : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{
    Headers: { "x-cantrip-webhook-token"?: string };
    Params: { triggerId: string };
  }>("/api/workflow-hooks/:triggerId", async (request, reply) => {
    const context = await repository.workflowTriggers.getWebhookDeliveryContext(
      request.params.triggerId,
    );
    const token = request.headers["x-cantrip-webhook-token"];
    if (
      !context ||
      context.trigger.type !== "webhook" ||
      !context.credentialHash ||
      typeof token !== "string" ||
      !safeCredentialMatch(token, context.credentialHash)
    ) {
      return reply.code(404).send({ error: "Webhook not found." });
    }
    const input = workflowWebhookDeliveryCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const result = await runAsOwner(context.trigger.ownerId, () =>
        deliverWorkflowTrigger({
          actorId: null,
          actorType: "webhook",
          allowOfflineQueue: false,
          allowedType: "webhook",
          idempotencyKey: input.data.idempotencyKey,
          protectedPayload: null,
          triggerId: request.params.triggerId,
        }),
      );
      return reply
        .code(result.replayed ? 200 : 201)
        .send(workflowTriggerDeliveryWireResultSchema.parse(result));
    } catch (error) {
      if (error instanceof WorkflowTriggerRateLimitError) {
        return reply
          .header("retry-after", String(error.retryAfterSeconds))
          .code(429)
          .send({ error: error.message });
      }
      const status =
        error instanceof WorkerUnavailableError
          ? 503
          : error instanceof WorkflowTriggerConflictError ||
              error instanceof WorkflowRunConflictError
            ? 409
            : 502;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { triggerId: string } }>(
    "/api/workflow-triggers/:triggerId/git-event",
    async (request, reply) => {
      const input = encryptedWorkflowGitEventDeliveryCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.workflowTriggers.getDeliveryContext(
        applicationOwnerId(),
        request.params.triggerId,
      );
      if (
        !context ||
        context.trigger.type !== "git" ||
        context.trigger.publicConfiguration.type !== "git" ||
        context.trigger.publicConfiguration.event !== input.data.event
      ) {
        return reply
          .code(409)
          .send({ error: "Git event does not match this workflow trigger." });
      }
      const project = await repository.getProject(
        applicationOwnerId(),
        context.trigger.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      requireProjectCapability(project, "git");
      try {
        const result = await deliverWorkflowTrigger({
          actorId: null,
          actorType: "git",
          allowOfflineQueue: false,
          allowedType: "git",
          idempotencyKey: input.data.deliveryId,
          protectedPayload: input.data.protectedPayload,
          triggerId: request.params.triggerId,
        });
        return reply
          .code(result.replayed ? 200 : 201)
          .send(workflowTriggerDeliveryWireResultSchema.parse(result));
      } catch (error) {
        if (error instanceof WorkflowTriggerRateLimitError) {
          return reply
            .header("retry-after", String(error.retryAfterSeconds))
            .code(429)
            .send({ error: error.message });
        }
        const status =
          error instanceof WorkerUnavailableError
            ? 503
            : error instanceof WorkflowTriggerConflictError ||
                error instanceof WorkflowRunConflictError
              ? 409
              : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { triggerId: string } }>(
    "/api/workflow-triggers/:triggerId/invoke",
    async (request, reply) => {
      const input = encryptedWorkflowTriggerDeliveryCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.workflowTriggers.getDeliveryContext(
        applicationOwnerId(),
        request.params.triggerId,
      );
      if (!context || context.trigger.type !== "saved-command") {
        return reply.code(404).send({ error: "Saved command not found." });
      }
      try {
        const result = await deliverWorkflowTrigger({
          actorId: applicationOwnerId(),
          actorType: "user",
          allowOfflineQueue: false,
          allowedType: "saved-command",
          idempotencyKey: input.data.idempotencyKey,
          protectedPayload: input.data.protectedPayload,
          triggerId: request.params.triggerId,
        });
        return reply
          .code(result.replayed ? 200 : 201)
          .send(workflowTriggerDeliveryWireResultSchema.parse(result));
      } catch (error) {
        if (error instanceof WorkflowTriggerRateLimitError) {
          return reply
            .header("retry-after", String(error.retryAfterSeconds))
            .code(429)
            .send({ error: error.message });
        }
        const status =
          error instanceof WorkerUnavailableError
            ? 503
            : error instanceof WorkflowTriggerConflictError ||
                error instanceof WorkflowRunConflictError
              ? 409
              : 502;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );
}
