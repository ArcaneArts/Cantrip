import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import {
  decisionOutcomeSchema,
  embeddingOutcomeSchema,
  modelOperationContentContext,
  protectedEmbeddingResponseSchema,
  providerApiKeyProtectedContentSchema,
} from "../../packages/protocol/dist/index.js";

export async function modelOperationClient(
  {
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    providerKey,
    operationsKey,
  },
  upstream,
  name,
) {
  const { server } = await call("GET", "/api/bootstrap", 200);
  const id = randomUUID();
  const protectedApiKey = await crypto.encryptProtectedSecret({
    ownerId,
    keyRevision,
    componentKey: providerKey,
    component: "provider-credential",
    table: "model_providers",
    rowId: id,
    field: "protected_api_key",
    content: { version: 1, apiKey: upstream.apiKey },
    contentSchema: providerApiKeyProtectedContentSchema,
    maximumBytes: 16 * 1024,
  });
  const provider = await call("POST", "/api/settings/providers", 201, {
    id,
    kind: "openai-compatible",
    name,
    baseUrl: upstream.baseUrl,
    protectedApiKey,
    initialAccount: null,
    maxConcurrentInference: 1,
  });
  return {
    async model(operation, { name, modelName, adapter, options }) {
      return call("POST", "/api/settings/models", 201, {
        operation,
        name,
        routes: [
          {
            providerId: provider.id,
            modelName,
            enabled: true,
            operationAdapter: adapter,
            operationOptions: options,
          },
        ],
      });
    },
    async make(operation, model, input, marker) {
      const scope = {
        workerId,
        modelId: model.id,
        routeId: model.routes[0].id,
      };
      const operationId = randomUUID();
      const context = (direction) =>
        modelOperationContentContext({
          serverId: server.id,
          operation,
          operationId,
          scope,
          direction,
        });
      const key = { ownerId, keyRevision, componentKey: operationsKey };
      const protectedRequest = await crypto.encryptEndpointContentPayload({
        ...key,
        context: context("request"),
        plaintext: Buffer.from(JSON.stringify(input)),
      });
      const wire = { operationId, scope, protectedRequest };
      const route = `/api/model-operations/${operation}`;
      return {
        operationId,
        async run() {
          const raw = await call("POST", route, 200, wire);
          const response = protectedEmbeddingResponseSchema.parse(raw);
          assert.equal(response.operationId, operationId);
          assert.deepEqual(response.scope, scope);
          assert.ok(!JSON.stringify(raw).includes(marker));
          const plaintext = await crypto.decryptEndpointContentPayload({
            ...key,
            context: context("response"),
            opaque: response.protectedResponse,
          });
          const schema =
            operation === "embedding"
              ? embeddingOutcomeSchema
              : decisionOutcomeSchema;
          return schema.parse(JSON.parse(Buffer.from(plaintext)));
        },
        cancel: () =>
          call("POST", route + "/cancel", 200, { operationId, scope }),
      };
    },
    usage: (id, verify) =>
      eventually(async () => {
        const report = await call(
          "GET",
          `/api/analytics/provider-telemetry/${provider.id}/export`,
          200,
        );
        return report.tokenUsage.find((row) => row.executionAttemptId === id)
          ?.modelOperationUsage?.receipt;
      }, verify),
  };
}
