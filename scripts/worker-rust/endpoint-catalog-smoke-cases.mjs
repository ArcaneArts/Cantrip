// Disposable provider HTTP behind the production worker and Core settings API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { encryptProtectedSecret } from "../../packages/crypto/dist/index.js";
import { providerApiKeyProtectedContentSchema } from "../../packages/protocol/dist/index.js";

export async function verifyEndpointCatalog({
  call,
  ownerId,
  workerId,
  keyRevision,
  componentKey,
}) {
  const apiKey = "disposable-endpoint-fixture-key";
  const observed = [];
  let studio = "rich";
  const upstream = createServer((request, response) => {
    observed.push({
      path: request.url,
      authorization: request.headers.authorization,
    });
    const json = (body) =>
      response
        .setHeader("content-type", "application/json")
        .end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401).end();
      return;
    }
    const entries = (begin, end) =>
      Array.from({ length: end - begin }, (_, i) => ({
        id: `model-${String(begin + i).padStart(3, "0")}`,
        max_model_len: 8192,
      }));
    switch (request.url) {
      case "/studio/v1/models":
        if (studio === "redirect") {
          response.writeHead(302, { Location: "/unexpected-redirect" }).end();
          return;
        }
        json({ data: entries(0, 120), links: { next: "?cursor=2" } });
        return;
      case "/studio/v1/models?cursor=2":
        json({ data: entries(120, 205) });
        return;
      case "/studio/api/v1/models":
        json({
          models: [
            {
              key: "model-000",
              type: "vlm",
              display_name: "Local vision model",
              loaded_instances: [
                {
                  config: {
                    context_length: studio === "rich" ? 131072 : 65536,
                  },
                },
              ],
              capabilities: { vision: true, trained_for_tool_use: true },
            },
            studio === "rich"
              ? { key: "native-only", type: "llm" }
              : { display_name: "Malformed" },
          ],
        });
        return;
      case "/gateway/v1/models":
        json({ data: [{ id: "vector" }, { id: "review" }] });
        return;
      case "/gateway/v1/model/info":
        json({
          data: [
            {
              model_name: "vector",
              model_info: { mode: "embedding", max_input_tokens: 8192 },
              litellm_params: { api_key: "private-upstream-fixture" },
            },
            {
              model_name: "vector",
              model_info: { mode: "embedding", max_input_tokens: 4096 },
            },
            {
              model_name: "review",
              model_info: { mode: "decisions", supports_audio_input: true },
            },
            {
              model_name: "unlisted-private-alias",
              model_info: { mode: "chat" },
            },
          ],
        });
        return;
      default:
        response.writeHead(404).end();
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const create = async (kind, suffix) => {
      const id = randomUUID();
      const result = await call("POST", "/api/settings/providers", 201, {
        id,
        name: `Catalog fixture ${kind}`,
        kind,
        baseUrl: origin + suffix,
        initialAccount: null,
        protectedApiKey: await encryptProtectedSecret({
          ownerId,
          keyRevision,
          componentKey,
          component: "provider-credential",
          table: "model_providers",
          rowId: id,
          field: "protected_api_key",
          content: { version: 1, apiKey },
          contentSchema: providerApiKeyProtectedContentSchema,
          maximumBytes: 16 * 1024,
        }),
      });
      return () =>
        call(
          "POST",
          `/api/settings/providers/${result.id}/catalog/refresh?workerId=${encodeURIComponent(workerId)}`,
          200,
          {},
        );
    };
    const refreshStudio = await create("lm-studio", "/studio/v1/responses");
    const first = await refreshStudio();
    assert.equal(first.models.length, 206);
    assert.equal(
      new Set(first.models.map((model) => model.nativeModelId)).size,
      206,
    );
    const record = (value, id) =>
      value.models.find((model) => model.nativeModelId === id);
    assert.equal(record(first, "model-204").contextWindow, 8192);
    assert.equal(record(first, "model-000").contextWindow, 131072);
    assert.equal(record(first, "model-000").loaded, true);
    assert.equal(record(first, "model-000").supportsVision, true);
    assert.ok(
      observed.some((request) => request.path === "/studio/v1/models?cursor=2"),
    );

    studio = "malformed";
    const partial = await refreshStudio();
    assert.ok(
      record(partial, "native-only"),
      "an incomplete native list preserves prior models",
    );
    assert.equal(
      record(partial, "model-000").contextWindow,
      8192,
      "a failed overlay preserves the standard list",
    );

    studio = "redirect";
    const stale = await refreshStudio();
    assert.equal(stale.servedStale, true);
    assert.equal(
      record(stale, "native-only").id,
      record(first, "native-only").id,
    );
    assert.ok(
      !observed.some((request) => request.path === "/unexpected-redirect"),
    );

    const refreshGateway = await create("litellm", "/gateway/v1");
    const gateway = await refreshGateway();
    assert.deepEqual(
      gateway.models.map((model) => model.nativeModelId).sort(),
      ["review", "vector"],
    );
    assert.equal(
      record(gateway, "vector").operationCapabilities.embedding.maxInputTokens,
      4096,
    );
    assert.equal(
      record(gateway, "review").operationCapabilities.decision.adapter,
      "openai-decisions",
    );
    assert.ok(record(gateway, "review").inputModalities.includes("audio"));
    for (const secret of [
      apiKey,
      "private-upstream-fixture",
      "unlisted-private-alias",
    ]) {
      assert.ok(!JSON.stringify(gateway).includes(secret));
    }
    assert.ok(
      observed.every((request) => request.authorization === `Bearer ${apiKey}`),
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}
