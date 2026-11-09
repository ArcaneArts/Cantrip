import * as p from "../../packages/protocol/dist/index.js";
import { taskInputWireFixtures } from "./task-input-wire-fixtures.mjs";

export function modelOperationWireFixtures(fixtures, at) {
  const { command } = taskInputWireFixtures();
  const operationId = "00000000-0000-4000-8000-000000000001";
  const scope = { workerId: "worker", modelId: "model", routeId: "route" };
  const content = {
    formatVersion: 1,
    domain: "model-operation-content",
    keyRevision: 1,
    envelope:
      fixtures.protectedNativeSettingsSnapshotSchema[0].protectedContent,
  };
  const request = { operationId, scope, protectedRequest: content };
  const response = { operationId, scope, protectedResponse: content };
  const route = {
    modelId: "model",
    routeId: "route",
    modelName: "model",
    adapter: "openai-embeddings",
    options: {},
    provider: command.provider,
  };
  const usage = {
    operation: "embedding",
    modelId: route.modelId,
    routeId: route.routeId,
    providerId: route.provider.id,
    workerVersion: null,
    status: "completed",
    requests: 1,
    succeededRequests: 1,
    failedRequests: 0,
    cancelledRequests: 0,
    startedAt: at,
    completedAt: at,
    durationMs: 0.25,
    observedTotalTokens: 12,
    observedTotalOverflowed: false,
    metrics: Object.fromEntries(
      p.MODEL_OPERATION_USAGE_METRICS.map((name) => [
        name,
        {
          observed: ["inputTokens", "totalTokens"].includes(name) ? 12 : null,
          reportedRequests: ["inputTokens", "totalTokens"].includes(name)
            ? 1
            : 0,
          overflowed: false,
        },
      ]),
    ),
  };
  const receipts = ["embedding", "decision"].flatMap((operation) =>
    ["completed", "failed", "cancelled"].map((status) => ({
      ...usage,
      operation,
      status,
      succeededRequests: status === "completed" ? 1 : 0,
      failedRequests: status === "failed" ? 1 : 0,
      cancelledRequests: status === "cancelled" ? 1 : 0,
    })),
  );
  const identity = {
    operation: usage.operation,
    modelId: usage.modelId,
    routeId: usage.routeId,
    providerId: usage.providerId,
    serverId: "server",
    workerId: scope.workerId,
    operationId,
  };
  const page = {
    transferId: operationId,
    snapshotId: operationId,
    observedAt: at,
    offset: 0,
    nextOffset: null,
    total: 1,
  };
  return {
    protectedEmbeddingRequestSchema: [
      request,
      { ...request, scope: { workerId: "worker", modelId: null } },
    ],
    protectedDecisionRequestSchema: [request],
    protectedEmbeddingResponseSchema: [response],
    protectedDecisionResponseSchema: [response],
    modelOperationCancelSchema: [{ operationId, scope }],
    modelOperationCancelResultSchema: [false, true].map((cancelled) => ({
      operationId,
      cancelled,
    })),
    modelOperationRouteSchema: [
      route,
      { ...route, adapter: null, capabilities: {}, observedRevision: null },
      {
        ...route,
        adapter: "openai-decisions",
        options: { timeoutMs: 1000, parameters: { temperature: 0 } },
      },
    ],
    modelOperationUsageSchema: receipts,
    modelOperationUsageIdentitySchema: [
      identity,
      { ...identity, operation: "decision" },
    ],
    modelOperationUsageEvidenceSchema: [
      ...receipts.map((receipt) => ({
        identity: { ...identity, operation: receipt.operation },
        receipt,
        transportStatus: "replied",
      })),
      ...["running", "unavailable"].map((transportStatus) => ({
        identity,
        receipt: null,
        transportStatus,
      })),
    ],
    modelCatalogPageRequestSchema: [
      { transferId: operationId },
      { transferId: operationId, snapshotId: operationId, offset: 200 },
    ],
    modelCatalogPageSchema: [
      {
        ...page,
        kind: "endpoint",
        metadataIncomplete: true,
        models: fixtures.endpointModelInventorySchema
          .find(({ models }) => models.length > 0)
          .models.slice(0, 1),
      },
      {
        ...page,
        kind: "ollama",
        models: fixtures.ollamaModelInventorySchema
          .find(({ models }) => models.length > 0)
          .models.slice(0, 1),
      },
      { ...page, kind: "endpoint", total: 0, models: [] },
      {
        ...page,
        kind: "ollama",
        offset: 200,
        nextOffset: 201,
        total: 202,
        models: fixtures.ollamaModelInventorySchema
          .find(({ models }) => models.length > 0)
          .models.slice(0, 1),
      },
    ],
  };
}
