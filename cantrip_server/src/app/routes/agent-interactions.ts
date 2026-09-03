import {
  agentInteractionAcceptedSchema,
  agentInteractionRequestQuerySchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestWireSchema,
  agentInteractionResolutionWireCreateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

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

export interface AgentInteractionRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: ServerRepository;
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
