// Exercise the public API and both Rust services. Only the provider is local.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import {
  embeddingInputSchema,
  embeddingOutcomeSchema,
  modelOperationContentContext,
  protectedEmbeddingResponseSchema,
  providerApiKeyProtectedContentSchema,
} from "../../packages/protocol/dist/index.js";
import { modelOperationProvider } from "../server-rust/model-operation-provider.mjs";

export async function verifyEmbeddings({
  call,
  eventually,
  ownerId,
  workerId,
  keyRevision,
  providerKey,
  operationsKey,
}) {
  const upstream = await modelOperationProvider();
  try {
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
      name: "Embedding fixture provider",
      baseUrl: upstream.baseUrl,
      protectedApiKey,
      initialAccount: null,
      maxConcurrentInference: 1,
    });
    const modelName = "owned-embedding-model";
    const model = await call("POST", "/api/settings/models", 201, {
      operation: "embedding",
      name: "Embedding fixture model",
      routes: [
        {
          providerId: provider.id,
          modelName,
          enabled: true,
          operationAdapter: "openai-embeddings",
          operationOptions: { maxBatchSize: 2 },
        },
      ],
    });
    const scope = { workerId, modelId: model.id, routeId: model.routes[0].id };
    const marker = "Private semantic document 🧭";
    const content = ({ n = 1, ...options } = {}) =>
      embeddingInputSchema.parse({
        items: Array.from({ length: n }, (_, index) => ({
          id: `item-${index}`,
          content: [{ type: "text", text: `${marker} ${index}` }],
        })),
        ...options,
      });
    const make = async (input) => {
      const operationId = randomUUID();
      const context = (direction) =>
        modelOperationContentContext({
          serverId: server.id,
          operationId,
          scope,
          direction,
        });
      const key = {
        ownerId,
        keyRevision,
        componentKey: operationsKey,
      };
      const protectedRequest = await crypto.encryptEndpointContentPayload({
        ...key,
        context: context("request"),
        plaintext: Buffer.from(JSON.stringify(input)),
      });
      const wire = { operationId, scope, protectedRequest };
      return {
        operationId,
        async run() {
          const raw = await call(
            "POST",
            "/api/model-operations/embedding",
            200,
            wire,
          );
          const response = protectedEmbeddingResponseSchema.parse(raw);
          assert.equal(response.operationId, operationId);
          assert.deepEqual(response.scope, scope);
          assert.ok(!JSON.stringify(raw).includes(marker));
          const plaintext = await crypto.decryptEndpointContentPayload({
            ...key,
            context: context("response"),
            opaque: response.protectedResponse,
          });
          return embeddingOutcomeSchema.parse(
            JSON.parse(Buffer.from(plaintext)),
          );
        },
        cancel: () =>
          call("POST", "/api/model-operations/embedding/cancel", 200, {
            operationId,
            scope,
          }),
      };
    };
    const usage = async (id, verify) =>
      eventually(async () => {
        const report = await call(
          "GET",
          `/api/analytics/provider-telemetry/${provider.id}/export`,
          200,
        );
        return report.tokenUsage.find((row) => row.executionAttemptId === id)
          ?.modelOperationUsage?.receipt;
      }, verify);

    upstream.reply("embedding");
    upstream.reply("embedding");
    const first = await make(content({ n: 3 }));
    const output = await first.run();
    assert.equal(output.status, "succeeded", JSON.stringify(output.error));
    assert.equal(output.value.batches, 2);
    assert.deepEqual(
      output.value.items.map(({ index, id, values }) => [index, id, values]),
      [
        [0, "item-0", [1, 0.5, -0.25]],
        [1, "item-1", [2, 0.5, -0.25]],
        [2, "item-2", [1, 0.5, -0.25]],
      ],
    );
    assert.deepEqual(output.value.usage, { inputTokens: 10, totalTokens: 10 });
    const { fingerprint, ...space } = output.value.space;
    const canonical = (value) => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`;
      }
      return JSON.stringify(value);
    };
    assert.equal(
      fingerprint,
      createHash("sha256")
        .update(
          canonical({
            identity: space,
            configuration: {
              adapter: "openai-embeddings",
              encoding_format: "float",
              endpoint: upstream.baseUrl + "/embeddings",
              model: modelName,
            },
            mediaFormat: "content-parts",
          }),
        )
        .digest("hex"),
    );
    await usage(first.operationId, (receipt) => {
      assert.equal(receipt?.requests, 2);
      assert.equal(receipt.succeededRequests, 2);
      assert.equal(receipt.metrics.inputTokens.observed, 10);
      assert.equal(receipt.observedTotalTokens, 10);
    });
    const replay = await first.run();
    assert.equal(replay.error?.code, "invalid-request");
    assert.equal(upstream.requests.length, 2);

    upstream.reply("embedding", { unknownUsage: true });
    const pinned = await make(content({ expectedSpace: output.value.space }));
    const pin = await pinned.run();
    assert.equal(pin.value?.space.fingerprint, fingerprint);
    assert.deepEqual(pin.value.usage, { inputTokens: null, totalTokens: null });
    await usage(pinned.operationId, (receipt) => {
      assert.equal(receipt?.status, "completed");
      assert.deepEqual(receipt.metrics.inputTokens, {
        observed: null,
        reportedRequests: 0,
        overflowed: false,
      });
    });

    const held = upstream.reply("embedding", { hold: true });
    const cancelled = await make(content());
    const running = cancelled.run();
    running.catch(() => {});
    try {
      await eventually(
        () => held,
        (plan) => assert.ok(plan.entered),
      );
      assert.equal((await cancelled.cancel()).cancelled, true);
      assert.equal((await running).error?.code, "cancelled");
      await eventually(
        () => held.entry,
        (entry) => {
          assert.ok(entry.closed);
          assert.equal(entry.completed, false);
        },
      );
      await usage(cancelled.operationId, (receipt) => {
        assert.equal(receipt?.status, "cancelled");
        assert.equal(receipt.cancelledRequests, 1);
      });
      assert.equal((await cancelled.run()).error?.code, "cancelled");
    } finally {
      held.release();
      await running.catch(() => {});
    }

    upstream.reply("embedding", { status: 429 });
    const rejected = await make(content());
    const failure = (await rejected.run()).error;
    assert.equal(failure?.code, "provider-error");
    assert.equal(failure.httpStatus, 429);
    assert.ok(!failure.message.includes("Private provider diagnostic"));

    upstream.reply("embedding", { status: 302 });
    const redirected = await make(content());
    assert.deepEqual((await redirected.run()).error, {
      code: "provider-error",
      message: "The embedding provider request failed.",
      httpStatus: null,
    });
    assert.deepEqual(upstream.failures, []);
  } finally {
    await upstream.close();
  }
}
