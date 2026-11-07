import {
  MODEL_OPERATION_WIRE_BYTES_LIMIT,
  modelOperationCancelSchema,
  modelOperationCancelResultSchema,
  protectedEmbeddingRequestSchema,
  protectedEmbeddingResponseSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

export function installModelOperationRoutes(
  app: FastifyInstance,
  ports: {
    applicationOwnerId(): string;
    serverId: string;
    repository: ServerRepository;
    bridge: LimitedWorkerCommandBus;
  },
) {
  app.post(
    "/api/model-operations/embedding",
    { bodyLimit: MODEL_OPERATION_WIRE_BYTES_LIMIT },
    async (request, reply) => {
      const parsed = protectedEmbeddingRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          code: "invalid-request",
          error: "Invalid protected embedding request.",
        });
      const input = parsed.data,
        ownerId = ports.applicationOwnerId();
      let dispatched = false;
      let disconnected = reply.raw.destroyed;
      const cancel = () => {
        if (dispatched && !reply.raw.writableEnded)
          void ports.bridge
            .request(
              input.scope.workerId,
              {
                type: "model.operation.cancel",
                operationId: input.operationId,
                scope: input.scope,
                serverId: ports.serverId,
              },
              { ownerId, timeoutMs: 30000 },
            )
            .catch(() => {});
      };
      const closed = () => {
        disconnected = true;
        cancel();
      };
      reply.raw.once("close", closed);
      try {
        if (!(await ports.repository.getWorker(ownerId, input.scope.workerId)))
          return reply.code(404).send({ error: "Worker not found." });
        const modelId =
          input.scope.modelId ??
          (await ports.repository.getUserSettings(ownerId))
            .defaultEmbeddingModelId;
        if (!modelId)
          return reply.code(409).send({
            code: "configuration-required",
            error:
              "Configure a default embedding model or select a model explicitly.",
          });
        const route = await ports.repository.getModelOperationRoute(
          ownerId,
          "embedding",
          modelId,
          input.scope.workerId,
          input.scope.routeId ?? undefined,
        );
        if (!route)
          return reply.code(409).send({
            code: "configuration-required",
            error:
              "The selected embedding model has no configured enabled route.",
          });
        const command = {
          ...input,
          type: "model.embedding" as const,
          serverId: ports.serverId,
          route,
        };
        if (
          Buffer.byteLength(JSON.stringify(command)) >
          MODEL_OPERATION_WIRE_BYTES_LIMIT
        )
          return reply.code(413).send({
            code: "invalid-request",
            error:
              "The protected embedding command exceeds 7 MiB. Submit a smaller job or configuration.",
          });
        if (disconnected) return reply;
        dispatched = true;
        const raw = await ports.bridge.request(input.scope.workerId, command, {
          ownerId,
          timeoutMs: null,
        });
        const result = protectedEmbeddingResponseSchema.parse(raw);
        if (
          result.operationId !== input.operationId ||
          JSON.stringify(result.scope) !== JSON.stringify(input.scope)
        )
          throw new Error("Embedding response scope changed.");
        return reply.send(result);
      } catch {
        cancel();
        return reply.code(502).send({
          code: "model-operation-unavailable",
          error:
            "The embedding worker operation could not be completed. It was not automatically retried.",
        });
      } finally {
        reply.raw.off("close", closed);
      }
    },
  );
  app.post("/api/model-operations/embedding/cancel", async (request, reply) => {
    const parsed = modelOperationCancelSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid model operation cancellation." });
    const input = parsed.data,
      ownerId = ports.applicationOwnerId();
    if (!(await ports.repository.getWorker(ownerId, input.scope.workerId)))
      return reply.code(404).send({ error: "Worker not found." });
    try {
      return reply.send(
        modelOperationCancelResultSchema.parse(
          await ports.bridge.request(
            input.scope.workerId,
            {
              ...input,
              type: "model.operation.cancel",
              serverId: ports.serverId,
            },
            { ownerId, timeoutMs: 30000 },
          ),
        ),
      );
    } catch {
      return reply
        .code(502)
        .send({ error: "The worker could not confirm cancellation." });
    }
  });
}
