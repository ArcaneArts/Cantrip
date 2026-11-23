import {
  MODEL_CATALOG_MODEL_LIMIT,
  MODEL_CATALOG_BYTES_LIMIT,
  ollamaModelInventoryItemSchema,
  type OllamaModelInventory,
  type OllamaModelInventoryItem,
} from "@cantrip/protocol";

import { workerLogger } from "./logger.js";
import { fetchModelCatalogJson } from "./model-catalog-json.js";

const REQUEST_TIMEOUT_MS = 20_000;
const SHOW_CONCURRENCY = 4;

type FetchImplementation = typeof fetch;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        const normalized = stringValue(item);
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function isoDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ollamaApiUrl(baseUrl: string, endpoint: "show" | "tags"): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname
    .replace(/\/(?:api|v1)\/?$/u, "")
    .replace(/\/+$/u, "");
  url.pathname = `${basePath}/api/${endpoint}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function parallelMap<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}

export async function discoverOllamaModels(
  baseUrl: string,
  apiKey: string | null,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OllamaModelInventory> {
  const startedAtMs = Date.now();
  const endpointOrigin = new URL(baseUrl).origin;
  workerLogger.event("debug", "Ollama model catalog refresh began", {
    event: "provider.catalog.refresh-started",
    subsystem: "provider-catalog",
    operation: "ollama-catalog",
    status: "started",
    providerKind: "ollama",
    endpointOrigin,
  });
  try {
    const tagsPayload = objectValue(
      await fetchModelCatalogJson(
        ollamaApiUrl(baseUrl, "tags"),
        apiKey,
        fetchImplementation,
        REQUEST_TIMEOUT_MS,
        signal,
      ),
    );
    if (!Array.isArray(tagsPayload?.models)) {
      throw new Error("Ollama tags response did not contain a model list.");
    }
    const tags = tagsPayload.models.flatMap((value) => {
      const record = objectValue(value);
      const name = stringValue(record?.model) ?? stringValue(record?.name);
      return record && name ? [{ name, record }] : [];
    });

    if (tags.length > MODEL_CATALOG_MODEL_LIMIT)
      throw new Error("Model catalog exceeded the model count limit.");
    let bytes = 0;
    const models = await parallelMap(
      tags,
      SHOW_CONCURRENCY,
      async ({ name, record }): Promise<OllamaModelInventoryItem> => {
        const show = objectValue(
          await fetchModelCatalogJson(
            ollamaApiUrl(baseUrl, "show"),
            apiKey,
            fetchImplementation,
            REQUEST_TIMEOUT_MS,
            signal,
            {
              method: "POST",
              body: JSON.stringify({ model: name, verbose: false }),
            },
          ),
        );
        const details =
          objectValue(show?.details) ?? objectValue(record.details);
        const model = ollamaModelInventoryItemSchema.parse({
          name,
          modifiedAt: isoDate(show?.modified_at ?? record.modified_at),
          sizeBytes: nonnegativeInteger(record.size),
          digest: stringValue(record.digest),
          family: stringValue(details?.family),
          families: stringArray(details?.families),
          parameterSize: stringValue(details?.parameter_size),
          quantization: stringValue(details?.quantization_level),
          capabilities: stringArray(show?.capabilities).map((capability) =>
            capability.toLowerCase(),
          ),
          modelInfo: objectValue(show?.model_info) ?? {},
        });
        bytes += Buffer.byteLength(JSON.stringify(model)) + 1;
        if (bytes > MODEL_CATALOG_BYTES_LIMIT)
          throw new Error("Model catalog exceeded its snapshot byte limit.");
        return model;
      },
    );

    const inventory: OllamaModelInventory = {
      models,
      observedAt: new Date().toISOString(),
    };
    workerLogger.event("info", "Ollama model catalog refreshed", {
      event: "provider.catalog.refresh-completed",
      subsystem: "provider-catalog",
      operation: "ollama-catalog",
      status: "completed",
      providerKind: "ollama",
      endpointOrigin,
      durationMs: Date.now() - startedAtMs,
      counts: { models: inventory.models.length },
    });
    return inventory;
  } catch (error) {
    workerLogger.rateLimited(
      `ollama-catalog-failed:${endpointOrigin}`,
      "warn",
      "Ollama model catalog refresh failed",
      {
        event: "provider.catalog.refresh-failed",
        subsystem: "provider-catalog",
        operation: "ollama-catalog",
        reasonCode: "request-failed",
        status: "failed",
        providerKind: "ollama",
        endpointOrigin,
        durationMs: Date.now() - startedAtMs,
        error,
      },
    );
    throw error;
  }
}
