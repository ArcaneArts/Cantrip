import { describe, expect, it } from "vitest";

import { discoverOllamaModels } from "../src/ollama.js";
import { readWorkerLogs } from "../src/logger.js";

describe("Ollama discovery", () => {
  it("reads tags and bounded show metadata from the worker-local API", async () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;
    const requests: Array<{
      authorization: string | null;
      body: unknown;
      method: string;
      url: string;
    }> = [];
    const fetchImplementation = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method ?? "GET",
        url,
      });
      if (url.endsWith("/api/tags")) {
        return Response.json({
          models: [
            {
              model: "gemma4:12b",
              modified_at: "2026-08-14T12:00:00.123456789Z",
              size: 7_000_000_000,
              digest: "sha256:gemma4",
              details: {
                family: "gemma4",
                families: ["gemma4"],
                parameter_size: "12B",
                quantization_level: "Q4_K_M",
              },
            },
          ],
        });
      }
      return Response.json({
        capabilities: ["completion", "tools", "thinking", "vision"],
        details: {
          family: "gemma4",
          families: ["gemma4"],
          parameter_size: "12B",
          quantization_level: "Q4_K_M",
        },
        model_info: {
          "general.architecture": "gemma4",
          "gemma4.context_length": 131_072,
        },
      });
    }) as typeof fetch;

    const inventory = await discoverOllamaModels(
      "http://127.0.0.1:11434/v1",
      "ollama-secret",
      fetchImplementation,
    );
    expect(inventory.models).toEqual([
      expect.objectContaining({
        name: "gemma4:12b",
        digest: "sha256:gemma4",
        family: "gemma4",
        parameterSize: "12B",
        quantization: "Q4_K_M",
        capabilities: ["completion", "tools", "thinking", "vision"],
        modelInfo: expect.objectContaining({
          "gemma4.context_length": 131_072,
        }),
      }),
    ]);
    expect(requests).toEqual([
      {
        authorization: "Bearer ollama-secret",
        body: null,
        method: "GET",
        url: "http://127.0.0.1:11434/api/tags",
      },
      {
        authorization: "Bearer ollama-secret",
        body: { model: "gemma4:12b", verbose: false },
        method: "POST",
        url: "http://127.0.0.1:11434/api/show",
      },
    ]);
    expect(
      JSON.stringify(
        readWorkerLogs({
          afterCursor,
          limit: 200,
          minimumLevel: "trace",
        }).records,
      ),
    ).not.toContain("ollama-secret");
  });

  it("rejects malformed tag inventories", async () => {
    await expect(
      discoverOllamaModels("http://127.0.0.1:11434/v1", null, (async () =>
        Response.json({ data: [] })) as typeof fetch),
    ).rejects.toThrow("did not contain a model list");
  });
});
