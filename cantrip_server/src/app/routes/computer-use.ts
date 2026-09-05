import {
  CUA_MAX_CHUNKS,
  computerUseChunkEventSchema,
  computerUseHttpResultSchema,
  computerUseRequestSchema,
  computerUseResponseSchema,
  type ComputerUseChunkEvent,
  type ComputerUseOperation,
} from "@cantrip/protocol/computer-use";
import {
  cuaApprovalRequestEventSchema,
  cuaApprovalTerminalSchema,
  type CuaPreviewAuthority,
} from "@cantrip/protocol/computer-use-preview";
import type { FastifyInstance } from "fastify";

import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ComputerUseApprovalPublications } from "./computer-use-preview.js";

export interface ComputerUseRouteDependencies {
  applicationOwnerId: () => string;
  serverId: string;
  repository: Pick<ServerRepository, "getChatExecutionContext">;
  bridge: Pick<WorkerCommandBus, "request">;
  /** Production requires a worker-issued preview lease; legacy unit fixtures do not. */
  requirePreviewLease?: boolean;
  recordLiveEncryptedAgentInteractionRequest?: ServerRepository["recordEncryptedAgentInteractionRequest"];
  terminalizeLiveAgentInteractionRequest?: ServerRepository["terminalizeAgentInteractionRequestFromWorker"];
  approvalPublications?: ComputerUseApprovalPublications;
  runAsOwner?: <T>(ownerId: string, operation: () => T) => T;
  ensureWorkerNotificationSubscription?: (
    ownerId: string,
    workerId: string,
  ) => void;
  authorize: (input: {
    ownerId: string;
    context: ChatExecutionContext;
    operation: ComputerUseOperation;
    operationId: string;
    previewLeaseId?: string;
  }) => Promise<void | CuaPreviewAuthority>;
}

/**
 * Production requests carry current server authority and a worker-issued lease;
 * the worker applies the existing permission system before native operations.
 * The server never opens CUA content, stores snapshots, or selects a desktop
 * from client-provided IDs.
 */
export function installComputerUseRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    serverId,
    repository,
    bridge,
    authorize,
    requirePreviewLease = false,
    recordLiveEncryptedAgentInteractionRequest,
    terminalizeLiveAgentInteractionRequest,
    approvalPublications,
    runAsOwner = (_ownerId, operation) => operation(),
    ensureWorkerNotificationSubscription,
  }: ComputerUseRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/computer-use/operation",
    {
      bodyLimit: 128 * 1024,
      errorHandler: (error, _request, reply) =>
        reply
          .code(error.statusCode === 413 ? 413 : 400)
          .send({ error: "Invalid computer-use request." }),
    },
    async (request, reply) => {
      const input = computerUseRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({ error: "Invalid computer-use request." });
      }
      if (requirePreviewLease && !input.data.previewLeaseId)
        return reply
          .code(400)
          .send({ error: "A computer-use preview lease is required." });

      let ownerId: string;
      let context: ChatExecutionContext | null;
      try {
        ownerId = applicationOwnerId();
        context = await repository.getChatExecutionContext(
          ownerId,
          request.params.chatId,
        );
      } catch {
        return reply.code(503).send({ error: "Chat context is unavailable." });
      }
      if (!context) {
        return reply.code(404).send({ error: "Chat not found." });
      }
      // Stopping remains available after approval is revoked. The worker must
      // authenticate the sealed action, require this exact operation, and
      // validate its session scope before closing anything.
      let previewAuthority: CuaPreviewAuthority | void = undefined;
      if (
        input.data.operation !== "session.close" ||
        requirePreviewLease ||
        input.data.previewLeaseId
      ) {
        try {
          previewAuthority = await authorize({
            ownerId,
            context,
            operation: input.data.operation,
            operationId: input.data.operationId,
            ...(input.data.previewLeaseId
              ? { previewLeaseId: input.data.previewLeaseId }
              : {}),
          });
          if (
            (requirePreviewLease && !previewAuthority) ||
            (previewAuthority && !input.data.previewLeaseId)
          )
            throw new Error("Missing preview authority.");
        } catch {
          return reply
            .code(403)
            .send({ error: "Computer use is not authorized." });
        }
      }

      const chunks: ComputerUseChunkEvent[] = [];
      let approvalRequestKey: string | null = null;
      let approvalTerminalSeen = false;
      let acceptingChunks = true;
      let finishCommand: (() => void) | undefined;
      try {
        // Subscribe on the request-origin server too: its worker may be
        // connected to another instance of the existing coordinated relay.
        ensureWorkerNotificationSubscription?.(ownerId, context.workerId);
        finishCommand = approvalPublications?.beginCommand({
          ownerId,
          workerId: context.workerId,
          chatId: context.chatId,
        });
        const raw = await bridge.request(
          context.workerId,
          {
            type: "computer-use.operation",
            serverId,
            chatId: context.chatId,
            executionLaneId: previewAuthority ? null : context.executionLaneId,
            request: input.data,
            ...(previewAuthority
              ? {
                  preview: {
                    leaseId: input.data.previewLeaseId!,
                    authority: previewAuthority,
                  },
                }
              : {}),
          },
          {
            ownerId,
            timeoutMs: 30_000,
            onEvent: async (event) => {
              if (!acceptingChunks) return;
              if (event.type === "computer-use.approval.request") {
                const approval = cuaApprovalRequestEventSchema.parse(event);
                const provenance = approval.request.provenance;
                if (
                  !previewAuthority ||
                  !recordLiveEncryptedAgentInteractionRequest ||
                  approvalRequestKey ||
                  chunks.length ||
                  approval.operationId !== input.data.operationId ||
                  provenance.owner !== "computer-use" ||
                  provenance.chatId !== context.chatId ||
                  provenance.workerId !== context.workerId ||
                  approval.request.projectId !== context.projectId ||
                  provenance.threadId !== null ||
                  provenance.turnId !== null ||
                  provenance.itemId !== null ||
                  provenance.executionLaneId !== null ||
                  input.data.operation === "session.close"
                )
                  throw new Error("Invalid computer-use approval request.");
                approvalRequestKey = approval.request.requestKey;
                const record = () =>
                  runAsOwner(ownerId, () =>
                    recordLiveEncryptedAgentInteractionRequest(
                      approval.request,
                    ),
                  );
                if (approvalPublications)
                  await approvalPublications.publish(
                    {
                      ownerId,
                      workerId: context.workerId,
                      chatId: context.chatId,
                      requestKey: approval.request.requestKey,
                    },
                    record,
                  );
                else await record();
                return;
              }
              if (event.type === "computer-use.approval.terminal") {
                const terminal = cuaApprovalTerminalSchema.parse(event);
                if (
                  !terminalizeLiveAgentInteractionRequest ||
                  approvalTerminalSeen ||
                  terminal.chatId !== context.chatId ||
                  terminal.requestKey !== approvalRequestKey
                )
                  throw new Error(
                    "Invalid computer-use approval terminal event.",
                  );
                approvalTerminalSeen = true;
                await runAsOwner(ownerId, () =>
                  terminalizeLiveAgentInteractionRequest(
                    terminal.requestKey,
                    context.chatId,
                    context.workerId,
                    terminal.status,
                  ),
                );
                return;
              }
              const chunk = computerUseChunkEventSchema.safeParse(event);
              if (
                !chunk.success ||
                approvalRequestKey !== null ||
                input.data.operation !== "observation.snapshot" ||
                chunk.data.operationId !== input.data.operationId ||
                chunk.data.sequence !== chunks.length ||
                chunks.length >= CUA_MAX_CHUNKS
              ) {
                throw new Error("Invalid computer-use snapshot response.");
              }
              // Strict schema bounds every ciphertext and its metadata. The
              // count limit bounds the entire opaque accumulator as well.
              chunks.push(chunk.data);
            },
          },
        );
        acceptingChunks = false;
        const response = computerUseResponseSchema.safeParse(raw);
        if (
          !response.success ||
          response.data.operationId !== input.data.operationId
        ) {
          throw new Error("Invalid computer-use response.");
        }
        // Parsing creates an independent array before the accumulator is
        // cleared. Only the client can verify the sealed image manifest.
        return reply.send(
          computerUseHttpResultSchema.parse({
            response: response.data,
            chunks,
          }),
        );
      } catch {
        return reply.code(502).send({ error: "Computer-use request failed." });
      } finally {
        acceptingChunks = false;
        chunks.length = 0;
        finishCommand?.();
      }
    },
  );
}
