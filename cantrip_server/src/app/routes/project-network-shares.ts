import {
  PROJECT_SOURCE_UNAVAILABLE_CODE,
  PROJECT_SHARE_STATE_STALE_CODE,
  projectShareAttachmentWireSchema,
  projectShareTunnelCreateSchema,
  standaloneChatShareAttachmentWireSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import {
  ProjectShareStateStaleError,
  type ProjectShareTunnelBroker,
} from "../../project-shares/tunnel.js";
import type { TunnelRuntimeManager } from "../../tunnels/runtime.js";
import {
  WorkerCommandError,
  WorkerUnavailableError,
} from "../../workers/bridge.js";

export interface ProjectNetworkShareRouteDependencies {
  applicationOwnerId: () => string;
  directAttachments: Pick<DirectAttachmentCoordinator, "mutateResource">;
  projectShareTunnel: Pick<
    ProjectShareTunnelBroker,
    "open" | "revokeAttachment"
  >;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getManagedTunnel"
    | "getProjectSource"
    | "getTunnel"
    | "getWorker"
  >;
  tunnelRuntime: Pick<TunnelRuntimeManager, "revoke">;
}

export function installProjectNetworkShareRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    directAttachments,
    projectShareTunnel,
    repository,
    tunnelRuntime,
  }: ProjectNetworkShareRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/network-shares",
    async (request, reply) => {
      const input = projectShareTunnelCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const source = await repository.getProjectSource(
        ownerId,
        request.params.projectId,
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      if (source.workerId !== input.data.workerId) {
        return reply.code(409).send({
          code: "target-mismatch",
          error: "The protected project share targets another worker.",
        });
      }
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "tunnel",
          input.data.tunnelId,
          async () => {
            const existing = await repository.getManagedTunnel(ownerId, {
              kind: "project-share",
              id: request.params.projectId,
            });
            if (existing && existing.id !== input.data.tunnelId) {
              return reply.code(409).send({
                code: PROJECT_SHARE_STATE_STALE_CODE,
                error: "The project share tunnel identity is stale.",
              });
            }
            if (existing) {
              await Promise.all(
                existing.attachments.map(({ id }) =>
                  tunnelRuntime.revoke(ownerId, id, {
                    preserveTunnelState: true,
                  }),
                ),
              );
            }
            const attachment = await projectShareTunnel.open({
              ownerId,
              projectId: request.params.projectId,
              protectedRecord: input.data.protectedRecord,
              tunnelId: input.data.tunnelId,
              workerId: input.data.workerId,
            });
            return reply
              .code(201)
              .send(projectShareAttachmentWireSchema.parse(attachment));
          },
        );
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof ProjectShareStateStaleError) {
          return reply.code(409).send({
            code: PROJECT_SHARE_STATE_STALE_CODE,
            error: message,
          });
        }
        if (
          error instanceof WorkerCommandError &&
          error.code === PROJECT_SOURCE_UNAVAILABLE_CODE
        ) {
          return reply.code(409).send({
            code: PROJECT_SOURCE_UNAVAILABLE_CODE,
            error: message,
          });
        }
        return reply
          .code(
            error instanceof WorkerUnavailableError ||
              message.toLowerCase().includes("offline")
              ? 503
              : 502,
          )
          .send({ error: message });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/network-shares",
    async (request, reply) => {
      const input = projectShareTunnelCreateSchema.safeParse(request.body);
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
      if (context.contextKind !== "standalone") {
        return reply.code(409).send({
          error:
            "Scratch network shares are available only in standalone Chat.",
        });
      }
      if (context.workerId !== input.data.workerId) {
        return reply.code(409).send({
          code: "target-mismatch",
          error: "The protected Chat share targets another worker.",
        });
      }
      const worker = await repository.getWorker(ownerId, context.workerId);
      if (!worker?.standaloneChat.files.networkShare) {
        return reply.code(409).send({
          error: "The Chat worker does not support scratch network shares.",
        });
      }
      const managedResourceId = `chat:${context.chatId}`;
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "tunnel",
          input.data.tunnelId,
          async () => {
            const existing = await repository.getManagedTunnel(ownerId, {
              kind: "project-share",
              id: managedResourceId,
            });
            if (existing && existing.id !== input.data.tunnelId) {
              return reply.code(409).send({
                code: PROJECT_SHARE_STATE_STALE_CODE,
                error: "The Chat share tunnel identity is stale.",
              });
            }
            if (existing) {
              await Promise.all(
                existing.attachments.map(({ id }) =>
                  tunnelRuntime.revoke(ownerId, id, {
                    preserveTunnelState: true,
                  }),
                ),
              );
            }
            const attachment = await projectShareTunnel.open({
              ownerId,
              projectId: null,
              managedResourceId,
              standaloneRoot: {
                chatId: context.chatId,
                rootId: context.scratchRootId,
              },
              protectedRecord: input.data.protectedRecord,
              tunnelId: input.data.tunnelId,
              workerId: input.data.workerId,
            });
            return reply.code(201).send(
              standaloneChatShareAttachmentWireSchema.parse({
                attachmentId: attachment.attachmentId,
                chatId: context.chatId,
                protocol: attachment.protocol,
                tunnelId: attachment.tunnelId,
                expiresAt: attachment.expiresAt,
                mountLeaseMs: attachment.mountLeaseMs,
              }),
            );
          },
        );
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof ProjectShareStateStaleError) {
          return reply.code(409).send({
            code: PROJECT_SHARE_STATE_STALE_CODE,
            error: message,
          });
        }
        if (
          error instanceof WorkerCommandError &&
          error.code === PROJECT_SOURCE_UNAVAILABLE_CODE
        ) {
          return reply.code(409).send({
            code: PROJECT_SOURCE_UNAVAILABLE_CODE,
            error: message,
          });
        }
        return reply
          .code(
            error instanceof WorkerUnavailableError ||
              message.toLowerCase().includes("offline")
              ? 503
              : 502,
          )
          .send({ error: message });
      }
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/project-shares/:attachmentId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      return directAttachments.mutateResource(
        ownerId,
        "tunnel",
        request.params.attachmentId,
        async () => {
          const tunnel = await repository.getTunnel(
            ownerId,
            request.params.attachmentId,
          );
          if (
            !tunnel ||
            tunnel.origin !== "project-share" ||
            tunnel.managedBy?.kind !== "project-share"
          ) {
            return reply.code(404).send({ error: "Project share not found." });
          }
          await Promise.all(
            tunnel.attachments.map(({ id }) =>
              tunnelRuntime.revoke(ownerId, id, {
                preserveTunnelState: true,
              }),
            ),
          );
          const revoked = await projectShareTunnel.revokeAttachment(
            request.params.attachmentId,
            ownerId,
          );
          return revoked
            ? reply.code(204).send()
            : reply.code(404).send({ error: "Project share not found." });
        },
      );
    },
  );
}
