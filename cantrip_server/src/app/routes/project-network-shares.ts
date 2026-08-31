import {
  PROJECT_SOURCE_UNAVAILABLE_CODE,
  PROJECT_SHARE_STATE_STALE_CODE,
  projectShareAttachmentWireSchema,
  projectShareTunnelCreateSchema,
  standaloneChatShareAttachmentWireSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import {
  ProjectShareOperationError,
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
    | "getProjectWorktreeContext"
    | "getTunnel"
    | "getWorker"
  >;
  tunnelRuntime: Pick<TunnelRuntimeManager, "revoke">;
}

export interface ProjectShareFailureDetails {
  failureStage: string;
  message: string;
  reasonCode: string;
  statusCode: 409 | 502 | 503;
  workerRequestId?: string;
}

const STABLE_FAILURE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STABLE_DIAGNOSTIC_ID = /^[A-Za-z0-9._:-]+$/u;

function stableFailureCode(value: string | null | undefined): string | null {
  return value && value.length <= 100 && STABLE_FAILURE_CODE.test(value)
    ? value
    : null;
}

function stableDiagnosticId(value: string | undefined): string | undefined {
  return value && value.length <= 200 && STABLE_DIAGNOSTIC_ID.test(value)
    ? value
    : undefined;
}

export function projectShareFailureDetails(
  error: unknown,
): ProjectShareFailureDetails {
  const operationError =
    error instanceof ProjectShareOperationError ? error : null;
  const workerError = error instanceof WorkerCommandError ? error : null;
  const reasonCode =
    stableFailureCode(operationError?.code) ??
    stableFailureCode(workerError?.code) ??
    (error instanceof WorkerUnavailableError
      ? "worker-offline"
      : "project-share-open-failed");
  const failureStage =
    operationError?.failureStage ??
    (workerError
      ? "worker-share-open"
      : error instanceof WorkerUnavailableError
        ? "worker-connectivity"
        : "control-plane");
  const statusCode =
    reasonCode === PROJECT_SHARE_STATE_STALE_CODE ||
    reasonCode === PROJECT_SOURCE_UNAVAILABLE_CODE
      ? 409
      : reasonCode === "worker-offline"
        ? 503
        : 502;
  const message =
    reasonCode === PROJECT_SOURCE_UNAVAILABLE_CODE
      ? "Project source is unavailable."
      : reasonCode === "worker-offline"
        ? "The project worker is offline."
        : (operationError?.message ??
          (reasonCode === PROJECT_SHARE_STATE_STALE_CODE
            ? "Project share state is stale."
            : "Winterhold could not open the protected project share."));
  const workerRequestId = stableDiagnosticId(
    operationError?.workerRequestId ?? workerError?.requestId,
  );
  return {
    failureStage,
    message,
    reasonCode,
    statusCode,
    ...(workerRequestId ? { workerRequestId } : {}),
  };
}

function sendProjectShareFailure(
  reply: FastifyReply,
  error: unknown,
  context: {
    requestId: string;
    resourceKind: "chat" | "project";
    workerId: string;
  },
) {
  const { failureStage, message, reasonCode, statusCode, workerRequestId } =
    projectShareFailureDetails(error);
  serverLogger.event(
    statusCode >= 500 ? "error" : "warn",
    "Protected project share open failed",
    {
      event: "project_share.open.failed",
      subsystem: "project-share",
      operation: "open",
      status: "failed",
      requestId: context.requestId,
      ...(workerRequestId ? { workerRequestId } : {}),
      workerId: context.workerId,
      reasonCode,
      failureStage,
      resourceKind: context.resourceKind,
    },
  );
  return reply.code(statusCode).send({
    code: reasonCode,
    error: message,
    failureStage,
    requestId: context.requestId,
    workerId: context.workerId,
    ...(workerRequestId ? { workerRequestId } : {}),
  });
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
      const worktree = input.data.worktreeId
        ? await repository.getProjectWorktreeContext(
            ownerId,
            request.params.projectId,
            input.data.worktreeId,
          )
        : null;
      if (input.data.worktreeId && !worktree) {
        return reply.code(404).send({ error: "Project worktree not found." });
      }
      if ((worktree?.workerId ?? source.workerId) !== input.data.workerId) {
        return reply.code(409).send({
          code: "target-mismatch",
          error: "The protected project share targets another project worker.",
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
              throw new ProjectShareStateStaleError(
                "The project share tunnel identity is stale.",
              );
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
        return sendProjectShareFailure(reply, error, {
          requestId: String(request.id),
          resourceKind: "project",
          workerId: input.data.workerId,
        });
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
      if (input.data.worktreeId) {
        return reply.code(400).send({
          error: "Scratch network shares cannot target a project worktree.",
        });
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
              throw new ProjectShareStateStaleError(
                "The Chat share tunnel identity is stale.",
              );
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
        return sendProjectShareFailure(reply, error, {
          requestId: String(request.id),
          resourceKind: "chat",
          workerId: input.data.workerId,
        });
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
