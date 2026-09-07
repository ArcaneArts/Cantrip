import { cuaAgentAuthoritySchema } from "@cantrip/protocol/computer-use-agent";
import {
  agentInteractionAcceptedSchema,
  agentInteractionRequestQuerySchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestWireSchema,
  agentInteractionResolutionWireCreateSchema,
  type AgentInteractionRequestWire,
  type EncryptedAgentInteractionResolutionCreate,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AgentInteractionConflictError,
  type ChatExecutionContext,
  type ModelRuntime,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerConflictFailure } from "../../http/worker-request-failures.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import { computerUsePreviewAuthority } from "./computer-use-preview.js";

export interface AgentInteractionRouteDependencies {
  applicationOwnerId: () => string;
  serverId?: string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "listAgentInteractionRequests"
    | "getAgentInteractionRequest"
    | "validateEncryptedAgentInteractionResolution"
    | "validateAgentInteractionResolution"
    | "getChatExecutionContext"
  >;
  resolveLiveAgentInteractionRequest: (
    ...input: Parameters<ServerRepository["resolveAgentInteractionRequest"]>
  ) => ReturnType<ServerRepository["resolveAgentInteractionRequest"]>;
  resolveLiveEncryptedAgentInteractionRequest: (
    ...input: Parameters<
      ServerRepository["resolveEncryptedAgentInteractionRequest"]
    >
  ) => ReturnType<ServerRepository["resolveEncryptedAgentInteractionRequest"]>;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
}

/** Registers agent interaction inspection and response routes. */
export function installAgentInteractionRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    serverId,
    bridge,
    repository,
    resolveLiveAgentInteractionRequest,
    resolveLiveEncryptedAgentInteractionRequest,
    runtimeForContext,
  }: AgentInteractionRouteDependencies,
): void {
  app.get<{
    Querystring: {
      chatId?: string;
      limit?: string;
      status?: string;
    };
  }>("/api/agent-requests", async (request, reply) => {
    const query = agentInteractionRequestQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const requests = await repository.listAgentInteractionRequests(
      applicationOwnerId(),
      query.data,
    );
    return reply.send(agentInteractionRequestWireListSchema.parse(requests));
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId",
    async (request, reply) => {
      const interaction = await repository.getAgentInteractionRequest(
        applicationOwnerId(),
        request.params.requestId,
      );
      if (!interaction) {
        return reply.code(404).send({ error: "Agent request not found." });
      }
      return reply.send(agentInteractionRequestWireSchema.parse(interaction));
    },
  );

  app.post<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId/respond",
    async (request, reply) => {
      const input = agentInteractionResolutionWireCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const protectedInput =
          "protectedResponse" in input.data ? input.data : null;
        const visibleInput = "response" in input.data ? input.data : null;
        const existing = protectedInput
          ? await repository.validateEncryptedAgentInteractionResolution(
              applicationOwnerId(),
              request.params.requestId,
              protectedInput,
            )
          : await repository.validateAgentInteractionResolution(
              applicationOwnerId(),
              request.params.requestId,
              visibleInput!,
            );
        if (!existing) {
          return reply.code(404).send({ error: "Agent request not found." });
        }
        if (existing.provenance.owner === "computer-use") {
          return respondToComputerUseApproval(
            reply,
            applicationOwnerId(),
            existing,
            protectedInput,
            {
              bridge,
              repository,
              resolveLiveEncryptedAgentInteractionRequest,
              serverId,
            },
          );
        }
        if (existing.status !== "pending") {
          const replay = protectedInput
            ? await resolveLiveEncryptedAgentInteractionRequest(
                applicationOwnerId(),
                request.params.requestId,
                protectedInput,
              )
            : await resolveLiveAgentInteractionRequest(
                applicationOwnerId(),
                request.params.requestId,
                visibleInput!,
              );
          return reply.send(agentInteractionRequestWireSchema.parse(replay));
        }
        if (!existing.provenance.chatId) {
          return reply.code(409).send({
            error: "The interaction is not associated with an active chat.",
          });
        }
        const context = await repository.getChatExecutionContext(
          applicationOwnerId(),
          existing.provenance.chatId,
        );
        if (
          !context ||
          context.workerId !== existing.provenance.workerId ||
          context.executionLaneId !== existing.provenance.executionLaneId
        ) {
          return reply.code(409).send({
            error: "The interaction execution lane is no longer active.",
          });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Project worker is offline." });
        }
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Selected model was not found." });
        }
        try {
          agentInteractionAcceptedSchema.parse(
            await bridge.request(
              context.workerId,
              protectedInput
                ? {
                    type: "agent.interaction.respond.protected",
                    executionProfile:
                      context.contextKind === "standalone"
                        ? "standalone-chat"
                        : "ide",
                    requestKey: existing.requestKey,
                    response: {
                      classification: protectedInput.classification,
                      protectedResponse: protectedInput.protectedResponse,
                    },
                    model: runtime.model,
                    provider: runtime.provider,
                  }
                : {
                    type: "agent.interaction.respond",
                    executionProfile:
                      context.contextKind === "standalone"
                        ? "standalone-chat"
                        : "ide",
                    requestKey: existing.requestKey,
                    response: visibleInput!.response,
                    model: runtime.model,
                    provider: runtime.provider,
                  },
              { timeoutMs: 30_000 },
            ),
          );
        } catch (error) {
          return sendWorkerConflictFailure(
            reply,
            error,
            `The runtime no longer accepts this interaction: ${errorMessage(error)}`,
          );
        }
        const interaction = protectedInput
          ? await resolveLiveEncryptedAgentInteractionRequest(
              applicationOwnerId(),
              request.params.requestId,
              protectedInput,
            )
          : await resolveLiveAgentInteractionRequest(
              applicationOwnerId(),
              request.params.requestId,
              visibleInput!,
            );
        return reply.send(agentInteractionRequestWireSchema.parse(interaction));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return reply.code(503).send({ error: error.message });
        }
        if (error instanceof AgentInteractionConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}

/** Native approvals belong to the worker, not a selected model or Codex RPC. */
async function respondToComputerUseApproval(
  reply: FastifyReply,
  ownerId: string,
  existing: AgentInteractionRequestWire,
  input: EncryptedAgentInteractionResolutionCreate | null,
  {
    bridge,
    repository,
    resolveLiveEncryptedAgentInteractionRequest,
    serverId,
  }: Pick<
    AgentInteractionRouteDependencies,
    | "bridge"
    | "repository"
    | "resolveLiveEncryptedAgentInteractionRequest"
    | "serverId"
  >,
): Promise<FastifyReply> {
  if (!input) {
    return reply.code(409).send({
      error: "Computer-use approvals require a protected response.",
    });
  }
  try {
    const preview =
      existing.provenance.threadId === null &&
      existing.provenance.turnId === null &&
      existing.provenance.itemId === null &&
      existing.provenance.executionLaneId === null;
    const context = existing.provenance.chatId
      ? await repository.getChatExecutionContext(
          ownerId,
          existing.provenance.chatId,
        )
      : null;
    if (
      !context ||
      context.workerId !== existing.provenance.workerId ||
      (!preview &&
        context.executionLaneId !== existing.provenance.executionLaneId) ||
      (existing.status !== "pending" && existing.status !== "resolved")
    ) {
      return reply.code(409).send({
        error: "The computer-use approval is no longer active.",
      });
    }
    const previewAuthority = preview
      ? computerUsePreviewAuthority({ ownerId, serverId: serverId!, context })
      : undefined;
    const agentAuthority = !preview
      ? cuaAgentAuthoritySchema.parse({
          ...computerUsePreviewAuthority({
            ownerId,
            serverId: serverId!,
            context,
          }),
          executionLaneId: context.executionLaneId,
        })
      : undefined;
    // A durable replay verifies its original idempotency key below. Never
    // re-authorize an action that the worker has already acknowledged.
    if (existing.status === "pending") {
      try {
        agentInteractionAcceptedSchema.parse(
          await bridge.request(
            context.workerId,
            {
              type: "computer-use.approval.respond",
              ownerId,
              chatId: context.chatId,
              executionLaneId: preview ? null : context.executionLaneId,
              requestKey: existing.requestKey,
              response: {
                classification: input.classification,
                protectedResponse: input.protectedResponse,
              },
              ...(previewAuthority ? { previewAuthority } : { agentAuthority }),
            },
            { ownerId, timeoutMs: 30_000 },
          ),
        );
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 409)
          .send({
            error: "The worker no longer accepts this computer-use approval.",
          });
      }
    }
    const resolved = await resolveLiveEncryptedAgentInteractionRequest(
      ownerId,
      existing.id,
      input,
    );
    return reply.send(agentInteractionRequestWireSchema.parse(resolved));
  } catch (error) {
    return reply
      .code(error instanceof AgentInteractionConflictError ? 409 : 503)
      .send({ error: "The computer-use approval could not be resolved." });
  }
}
