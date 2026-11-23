import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { describe, expect, it } from "vitest";

import {
  discoverEndpointModels,
  normalizeEndpointModel,
} from "./endpoint-models.js";

async function endpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not listen.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/proxy/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("endpoint model discovery", () => {
  it.each(["lm-studio", "llama-cpp", "vllm", "unsloth", "litellm", "mlx-lm"])(
    "reads %s models from the actual API root and preserves unknown capabilities",
    async (kind) => {
      const requests: Array<{
        path: string | undefined;
        key: string | undefined;
      }> = [];
      const modelPath =
        kind === "unsloth"
          ? "/proxy/v1/models?output_modalities=all"
          : "/proxy/v1/models";
      const fixture = await endpoint((request, response) => {
        requests.push({
          path: request.url,
          key: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        if (request.url !== modelPath) {
          response.writeHead(404).end();
          return;
        }
        response.end(
          JSON.stringify({ data: [{ id: "same-model", max_model_len: 8192 }] }),
        );
      });
      try {
        const result = await discoverEndpointModels({
          kind,
          baseUrl: `${fixture.baseUrl}/responses///`,
          apiKey: "fixture-key",
        });
        expect(result.models).toEqual([
          expect.objectContaining({
            nativeModelId: "same-model",
            contextWindow: 8192,
            supportsTools: null,
            supportsReasoning: null,
            loaded: null,
          }),
        ]);
        expect(requests[0]).toEqual({
          path: modelPath,
          key: "Bearer fixture-key",
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it("enriches LM Studio with loaded state without sending backend diagnostics or paths", async () => {
    const fixture = await endpoint((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/proxy/api/v1/models"
            ? {
                models: [
                  {
                    key: "same-model",
                    type: "llm",
                    display_name: "Local Model",
                    max_context_length: 32768,
                    loaded_instances: [
                      { id: "same-model", config: { context_length: 8192 } },
                    ],
                    capabilities: { trained_for_tool_use: true, vision: false },
                    quantization: { name: "Q4_K_M" },
                    path: "/private/model.gguf",
                    apiKey: "private-value",
                  },
                  { key: "embed", type: "embedding" },
                ],
              }
            : { data: [{ id: "same-model" }] },
        ),
      );
    });
    try {
      const result = await discoverEndpointModels({
        kind: "lm-studio",
        baseUrl: fixture.baseUrl,
        apiKey: null,
      });
      expect(result.models).toEqual([
        expect.objectContaining({
          nativeModelId: "same-model",
          displayName: "Local Model",
          contextWindow: 8192,
          loaded: true,
          supportsTools: true,
          quantization: "Q4_K_M",
        }),
        expect.objectContaining({
          nativeModelId: "embed",
          outputModalities: ["embeddings"],
          operationCapabilities: {
            language: expect.objectContaining({ status: "unsupported" }),
            embedding: expect.objectContaining({
              status: "supported",
              adapter: "openai-embeddings",
            }),
            decision: expect.objectContaining({ status: "unsupported" }),
          },
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain("private");
    } finally {
      await fixture.close();
    }
  });

  it("keeps instances with identical model IDs and distinct credentials independent", async () => {
    const first = await endpoint((request, response) =>
      response.end(
        JSON.stringify({
          data: [
            {
              id: "same-model",
              context_length:
                request.headers.authorization === "Bearer first-key" ? 4096 : 1,
            },
          ],
        }),
      ),
    );
    const second = await endpoint((request, response) =>
      response.end(
        JSON.stringify({
          data: [
            {
              id: "same-model",
              context_length:
                request.headers.authorization === "Bearer second-key"
                  ? 8192
                  : 1,
            },
          ],
        }),
      ),
    );
    try {
      const [a, b] = await Promise.all([
        discoverEndpointModels({
          kind: "vllm",
          baseUrl: first.baseUrl,
          apiKey: "first-key",
        }),
        discoverEndpointModels({
          kind: "vllm",
          baseUrl: second.baseUrl,
          apiKey: "second-key",
        }),
      ]);
      expect(a.models[0]?.contextWindow).toBe(4096);
      expect(b.models[0]?.contextWindow).toBe(8192);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("retains known standard metadata when native enrichment omits it", async () => {
    const fixture = await endpoint((request, response) => {
      response.end(
        JSON.stringify(
          request.url === "/proxy/api/v1/models"
            ? { models: [{ key: "same-model", loaded_instances: [] }] }
            : {
                data: [
                  {
                    id: "same-model",
                    name: "Named model",
                    context_length: 8192,
                    supports_tool_calling: true,
                    supports_vision: true,
                  },
                ],
              },
        ),
      );
    });
    try {
      const result = await discoverEndpointModels({
        kind: "lm-studio",
        baseUrl: fixture.baseUrl,
        apiKey: null,
      });
      expect(result.models[0]).toMatchObject({
        displayName: "Named model",
        contextWindow: 8192,
        supportsTools: true,
        supportsVision: true,
        inputModalities: ["text", "image"],
        loaded: false,
      });
    } finally {
      await fixture.close();
    }
  });

  it("omits authentication for keyless endpoints and redacts failed response bodies", async () => {
    const fixture = await endpoint((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(401).end("credential-sentinel");
    });
    try {
      await expect(
        discoverEndpointModels({
          kind: "unsloth",
          baseUrl: fixture.baseUrl,
          apiKey: null,
        }),
      ).rejects.toThrow("Model catalog request returned HTTP 401.");
    } finally {
      await fixture.close();
    }
  });

  it("does not expose malformed JSON contents", async () => {
    const fixture = await endpoint((_request, response) =>
      response.end("credential-sentinel"),
    );
    try {
      await expect(
        discoverEndpointModels({
          kind: "litellm",
          baseUrl: fixture.baseUrl,
          apiKey: null,
        }),
      ).rejects.toThrow("Model catalog response was not valid JSON.");
    } finally {
      await fixture.close();
    }
  });

  it("reports known unloaded models without inventing tool support", () => {
    expect(
      normalizeEndpointModel({
        key: "installed",
        type: "llm",
        loaded_instances: [],
      }),
    ).toMatchObject({
      nativeModelId: "installed",
      loaded: false,
      supportsTools: null,
    });
  });

  it("keeps embedding-only models out of language and decision routes", () => {
    expect(
      normalizeEndpointModel({ type: "embedding", id: "embed" }),
    ).toMatchObject({
      nativeModelId: "embed",
      outputModalities: ["embeddings"],
      supportsTools: null,
      operationCapabilities: {
        language: { status: "unsupported" },
        embedding: { status: "supported", adapter: "openai-embeddings" },
        decision: { status: "unsupported" },
      },
    });
  });
});
