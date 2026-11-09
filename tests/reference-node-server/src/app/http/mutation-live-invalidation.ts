import type { AppLiveResource } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  mutationChatLiveResources,
  mutationLiveResources,
  type ChatLiveResource,
} from "../shared/live-resources.js";

export interface MutationLiveInvalidationHookDependencies {
  publishChatInvalidation: (chatId: string, resource: ChatLiveResource) => void;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
}

/**
 * Publishes broad invalidations after successful mutating HTTP responses.
 * Install this after the live route to preserve the root hook order.
 */
export function installMutationLiveInvalidationHook(
  app: FastifyInstance,
  {
    publishChatInvalidation,
    publishLiveInvalidation,
  }: MutationLiveInvalidationHookDependencies,
): void {
  app.addHook("onResponse", async (request, reply) => {
    if (
      ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      reply.statusCode >= 400
    ) {
      return;
    }
    const route = request.routeOptions.url ?? "";
    const repositoryAccess =
      request.body !== null &&
      typeof request.body === "object" &&
      "access" in request.body &&
      request.body.access === "read"
        ? "read"
        : "write";
    const resources = mutationLiveResources(route, repositoryAccess);
    const chatResources = mutationChatLiveResources(route);
    if (resources.length === 0 && chatResources.length === 0) return;
    const params = request.params as Record<string, unknown>;
    const projectId =
      typeof params.projectId === "string" ? params.projectId : null;
    const entityId = [
      params.configurationId,
      params.worktreeId,
      params.chatId,
      params.terminalId,
      params.explorerId,
      params.browserId,
      params.codeTabId,
      params.desktopId,
      params.surfaceId,
      params.viewId,
      params.workerId,
      params.policyId,
      params.workspaceId,
      params.tunnelId,
      params.attachmentId,
      params.projectId,
    ].find((value): value is string => typeof value === "string");
    for (const resource of resources) {
      publishLiveInvalidation(resource, {
        entityId:
          resource === "policy"
            ? typeof params.policyId === "string"
              ? params.policyId
              : null
            : entityId,
        projectId: resource === "policy" ? null : projectId,
      });
    }
    const chatId = typeof params.chatId === "string" ? params.chatId : null;
    if (chatId) {
      for (const resource of chatResources) {
        publishChatInvalidation(chatId, resource);
      }
    }
  });
}
