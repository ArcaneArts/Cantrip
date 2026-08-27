import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import {
  projectCapabilityForRoute,
  requireProjectCapability,
} from "../../projects/capabilities.js";
import {
  removedPlaintextRepositoryRoute,
  standaloneChatFeatureForbidden,
} from "../shared/request-policy.js";

export function installRemovedPlaintextRouteGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (removedPlaintextRepositoryRoute(route)) {
      return reply.code(410).send({
        error:
          "This plaintext repository route was removed. Use the protected repository operation endpoint.",
      });
    }
  });
}

export function installProjectContextGuards(
  app: FastifyInstance,
  repository: ServerRepository,
  applicationOwnerId: () => string,
): void {
  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    const capability = projectCapabilityForRoute(request.method, route);
    if (!capability || !request.params || typeof request.params !== "object") {
      return;
    }
    const projectId = (request.params as Record<string, unknown>).projectId;
    if (typeof projectId !== "string" || projectId.length === 0) return;
    const project = await repository.getProject(
      applicationOwnerId(),
      projectId,
    );
    if (project) requireProjectCapability(project, capability);
  });

  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (
      !standaloneChatFeatureForbidden(route) ||
      !request.params ||
      typeof request.params !== "object"
    ) {
      return;
    }
    const chatId = (request.params as Record<string, unknown>).chatId;
    if (typeof chatId !== "string" || chatId.length === 0) return;
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (context?.contextKind === "standalone") {
      return reply.code(409).send({
        error: "This IDE-only Chat feature is unavailable in standalone Chat.",
      });
    }
  });
}
