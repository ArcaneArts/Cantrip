import {
  ollamaModelInventorySchema,
  type OllamaModelInventory,
  type OllamaModelInventoryItem,
} from "@cantrip/protocol";

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

async function requestJson(
  fetchImplementation: FetchImplementation,
  url: URL,
  apiKey: string | null,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetchImplementation(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama ${url.pathname} returned ${response.status} ${response.statusText}.`,
    );
  }
  return response.json();
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
): Promise<OllamaModelInventory> {
  const tagsPayload = objectValue(
    await requestJson(
      fetchImplementation,
      ollamaApiUrl(baseUrl, "tags"),
      apiKey,
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

  const models = await parallelMap(
    tags.slice(0, 1_000),
    SHOW_CONCURRENCY,
    async ({ name, record }): Promise<OllamaModelInventoryItem> => {
      const show = objectValue(
        await requestJson(
          fetchImplementation,
          ollamaApiUrl(baseUrl, "show"),
          apiKey,
          {
            method: "POST",
            body: JSON.stringify({ model: name, verbose: false }),
          },
        ),
      );
      const details = objectValue(show?.details) ?? objectValue(record.details);
      return {
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
      };
    },
  );

  return ollamaModelInventorySchema.parse({
    models,
    observedAt: new Date().toISOString(),
  });
}
