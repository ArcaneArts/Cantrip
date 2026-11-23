import {
  MODEL_OPERATION_WIRE_BYTES_LIMIT,
  modelOperationCancelSchema,
  modelOperationCancelResultSchema,
  protectedEmbeddingRequestSchema,
  protectedEmbeddingResponseSchema,
  modelOperationUsageSchema,
  modelOperationUsageFitsIdentity,
  type ModelOperationUsageIdentity,
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
  const reports = new Set<Promise<void>>();
  const report = (
    ownerId: string,
    identity: ModelOperationUsageIdentity,
    transportStatus: "running" | "replied" | "unavailable",
    rawReceipt?: unknown,
  ) => {
    const parsed = modelOperationUsageSchema.safeParse(rawReceipt);
    const work: Promise<void> = ports.repository
      .recordModelOperationUsage(ownerId, {
        identity,
        transportStatus,
        ...(parsed.success &&
        modelOperationUsageFitsIdentity(parsed.data, identity)
          ? { receipt: parsed.data }
          : {}),
      })
      .catch(() => {
        app.log.warn(
          {
            event: "model.operation.usage-unavailable",
            operation: identity.operation,
          },
          "Model operation usage could not be recorded.",
        );
      })
      .finally(() => reports.delete(work));
    reports.add(work);
  };
  app.addHook("onClose", async () => {
    await Promise.allSettled([...reports]);
  });
  for (const operation of ["embedding", "decision"] as const) {
    app.post(
      `/api/model-operations/${operation}`,
      { bodyLimit: MODEL_OPERATION_WIRE_BYTES_LIMIT },
      async (request, reply) => {
        const parsed = protectedEmbeddingRequestSchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({
            code: "invalid-request",
            error: `Invalid protected ${operation} request.`,
          });
        const input = parsed.data,
          ownerId = ports.applicationOwnerId();
        let dispatched = false;
        let disconnected = reply.raw.destroyed;
        let usageIdentity: ModelOperationUsageIdentity | undefined;
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
          if (
            !(await ports.repository.getWorker(ownerId, input.scope.workerId))
          )
            return reply.code(404).send({ error: "Worker not found." });
          const modelId =
            input.scope.modelId ??
            (await ports.repository.getUserSettings(ownerId))[
              operation === "embedding"
                ? "defaultEmbeddingModelId"
                : "defaultDecisionModelId"
            ];
          if (!modelId)
            return reply.code(409).send({
              code: "configuration-required",
              error: `Configure a default ${operation} model or select a model explicitly.`,
            });
          const route = await ports.repository.getModelOperationRoute(
            ownerId,
            operation,
            modelId,
            input.scope.workerId,
            input.scope.routeId ?? undefined,
          );
          if (!route)
            return reply.code(409).send({
              code: "configuration-required",
              error: `The selected ${operation} model has no configured enabled route.`,
            });
          const command = {
            ...input,
            type:
              operation === "embedding"
                ? ("model.embedding" as const)
                : ("model.decision" as const),
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
                "The protected model command exceeds 7 MiB. Submit a smaller job or configuration.",
            });
          if (disconnected) return reply;
          dispatched = true;
          usageIdentity = {
            serverId: ports.serverId,
            workerId: input.scope.workerId,
            operationId: input.operationId,
            operation,
            modelId: route.modelId,
            routeId: route.routeId,
            providerId: route.provider.id,
          };
          const pending = ports.bridge.request(input.scope.workerId, command, {
            ownerId,
            timeoutMs: null,
          });
          report(ownerId, usageIdentity, "running");
          const raw = await pending;
          const envelope =
            raw && typeof raw === "object"
              ? (raw as Record<string, unknown>)
              : {};
          const result = protectedEmbeddingResponseSchema.parse({
            operationId: envelope.operationId,
            scope: envelope.scope,
            protectedResponse: envelope.protectedResponse,
          });
          if (
            result.operationId !== input.operationId ||
            JSON.stringify(result.scope) !== JSON.stringify(input.scope)
          )
            throw new Error("Model operation response scope changed.");
          report(ownerId, usageIdentity, "replied", envelope.usageReceipt);
          return reply.send(result);
        } catch {
          cancel();
          if (usageIdentity) report(ownerId, usageIdentity, "unavailable");
          return reply.code(502).send({
            code: "model-operation-unavailable",
            error: `The ${operation} worker operation could not be completed. It was not automatically retried.`,
          });
        } finally {
          reply.raw.off("close", closed);
        }
      },
    );
    app.post(
      `/api/model-operations/${operation}/cancel`,
      async (request, reply) => {
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
      },
    );
  }
}
