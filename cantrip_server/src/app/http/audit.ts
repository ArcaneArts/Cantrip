import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import {
  auditResourceId,
  mutationAuditDescriptor,
} from "../shared/request-policy.js";

export interface AppendAuditInput {
  action: string;
  actorSessionId?: string | null;
  actorUserId?: string | null;
  ownerId?: string | null;
  resourceId?: string | null;
  resourceType: string;
  result: "denied" | "failed" | "succeeded";
}

export type AppendAudit = (
  request: FastifyRequest,
  input: AppendAuditInput,
) => Promise<void>;

export function createAuditAppender(repository: ServerRepository): AppendAudit {
  return async (request, input): Promise<void> => {
    const principal = request.principal;
    const authenticated = principal.state === "authenticated";
    try {
      await repository.appendAuditEvent({
        action: input.action,
        actorSessionId:
          input.actorSessionId === undefined
            ? authenticated
              ? principal.sessionId
              : null
            : input.actorSessionId,
        actorUserId:
          input.actorUserId === undefined
            ? authenticated
              ? principal.user.id
              : null
            : input.actorUserId,
        ownerId:
          input.ownerId === undefined
            ? authenticated
              ? principal.user.id
              : null
            : input.ownerId,
        requestId: request.id,
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType,
        result: input.result,
      });
    } catch (error) {
      request.log.error(
        {
          action: input.action,
          err: error,
          event: "security.audit-write-failed",
          requestId: request.id,
        },
        "Could not append security audit event",
      );
    }
  };
}

export function installMutationAuditHook(
  app: FastifyInstance,
  appendAudit: AppendAudit,
): void {
  app.addHook("onResponse", async (request, reply) => {
    if (
      request.method === "OPTIONS" ||
      request.principal.state !== "authenticated"
    ) {
      return;
    }
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    const descriptor = mutationAuditDescriptor(request.method, route);
    if (!descriptor) return;
    await appendAudit(request, {
      ...descriptor,
      resourceId: auditResourceId(request),
      result:
        reply.statusCode < 400
          ? "succeeded"
          : reply.statusCode === 401 || reply.statusCode === 403
            ? "denied"
            : "failed",
    });
  });
}
