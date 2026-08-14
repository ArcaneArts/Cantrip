import type {
  ProviderModelCatalogResult,
  ProviderModelMetadataSource,
} from "@cantrip/protocol";

import type {
  ModelProviderCatalogRuntime,
  ProviderModelCatalogWrite,
  ServerRepository,
} from "../db/repository.js";

export const OPENROUTER_GLOBAL_SCOPE = "openrouter:global";
export const OPENROUTER_USER_SCOPE = "openrouter:user";

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const OPENROUTER_REQUEST_TIMEOUT_MS = 30_000;

type FetchImplementation = typeof fetch;

export interface OpenRouterModelRecord extends Record<string, unknown> {
  id: string;
}

interface CatalogSnapshot {
  etag: string | null;
  fetchedAt: number;
  models: OpenRouterModelRecord[];
}

interface CatalogRead {
  backgroundRefresh: Promise<CatalogSnapshot> | null;
  servedStale: boolean;
  snapshot: CatalogSnapshot;
}

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

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        const normalized = stringValue(item)?.toLowerCase();
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

function parseCatalogPayload(payload: unknown): OpenRouterModelRecord[] {
  const data = objectValue(payload)?.data;
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter model catalog response did not contain data.");
  }
  return data.flatMap((entry) => {
    const record = objectValue(entry);
    const id = stringValue(record?.id);
    return record && id ? [{ ...record, id }] : [];
  });
}

function modelsUrl(baseUrl: string, userScoped: boolean): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path}/models${userScoped ? "/user" : ""}`;
  url.search = "";
  url.hash = "";
  return url;
}

function openRouterHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "openrouter.ai" || normalized.endsWith(".openrouter.ai")
  );
}

export function isOpenRouterProvider(
  provider: ModelProviderCatalogRuntime,
): boolean {
  try {
    return (
      provider.kind === "openai-compatible" &&
      openRouterHost(new URL(provider.baseUrl).hostname)
    );
  } catch {
    return false;
  }
}

export function normalizeOpenRouterModel(
  record: OpenRouterModelRecord,
): ProviderModelCatalogWrite {
  const architecture = objectValue(record.architecture);
  const topProvider = objectValue(record.top_provider);
  const supportedParameters = new Set(stringArray(record.supported_parameters));
  const inputModalities = stringArray(architecture?.input_modalities);
  const outputModalities = stringArray(architecture?.output_modalities);
  const supportsTools =
    supportedParameters.has("tools") || supportedParameters.has("tool_choice");
  const supportsReasoning = [
    "include_reasoning",
    "reasoning",
    "reasoning_effort",
  ].some((parameter) => supportedParameters.has(parameter));
  const metadataSource: ProviderModelMetadataSource = "openrouter";
  return {
    nativeModelId: record.id,
    canonicalModelId: stringValue(record.canonical_slug) ?? record.id,
    displayName: stringValue(record.name) ?? record.id,
    description: stringValue(record.description)?.slice(0, 20_000) ?? null,
    contextWindow:
      positiveInteger(topProvider?.context_length) ??
      positiveInteger(record.context_length),
    maxOutputTokens: positiveInteger(topProvider?.max_completion_tokens),
    inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
    outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
    supportsTools,
    supportsParallelTools: supportedParameters.has("parallel_tool_calls")
      ? true
      : supportsTools
        ? null
        : false,
    supportsStructuredOutput:
      supportedParameters.has("response_format") ||
      supportedParameters.has("structured_outputs"),
    supportsVision: inputModalities.includes("image"),
    supportsReasoning,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    reasoningMandatory: null,
    family:
      stringValue(architecture?.instruct_type) ??
      stringValue(architecture?.tokenizer),
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource,
    matchConfidenceBasisPoints: 10_000,
    rawMetadata: record,
  };
}

export class OpenRouterCatalogCache {
  readonly #cache = new Map<string, CatalogSnapshot>();
  readonly #fetch: FetchImplementation;
  readonly #inFlight = new Map<string, Promise<CatalogSnapshot>>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(
    options: {
      fetch?: FetchImplementation;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async read(input: {
    apiKey: string | null;
    baseUrl: string;
    cacheKey: string;
    force?: boolean;
    userScoped: boolean;
  }): Promise<CatalogRead> {
    const existing = this.#cache.get(input.cacheKey);
    const fresh = existing && this.#now() - existing.fetchedAt < this.#ttlMs;
    if (fresh && !input.force) {
      return {
        backgroundRefresh: null,
        servedStale: false,
        snapshot: existing,
      };
    }

    const refresh = this.#refresh(input, existing);
    if (existing && !input.force) {
      return {
        backgroundRefresh: refresh,
        servedStale: true,
        snapshot: existing,
      };
    }
    return {
      backgroundRefresh: null,
      servedStale: false,
      snapshot: await refresh,
    };
  }

  #refresh(
    input: {
      apiKey: string | null;
      baseUrl: string;
      cacheKey: string;
      userScoped: boolean;
    },
    existing: CatalogSnapshot | undefined,
  ): Promise<CatalogSnapshot> {
    const active = this.#inFlight.get(input.cacheKey);
    if (active) return active;
    const refresh = (async () => {
      const headers = new Headers({ accept: "application/json" });
      if (input.apiKey) {
        headers.set("authorization", `Bearer ${input.apiKey}`);
      }
      if (existing?.etag) headers.set("if-none-match", existing.etag);
      const response = await this.#fetch(
        modelsUrl(input.baseUrl, input.userScoped),
        {
          headers,
          signal: AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status === 304 && existing) {
        const snapshot = { ...existing, fetchedAt: this.#now() };
        this.#cache.set(input.cacheKey, snapshot);
        return snapshot;
      }
      if (!response.ok) {
        throw new Error(
          `OpenRouter model catalog returned ${response.status} ${response.statusText}.`,
        );
      }
      const snapshot: CatalogSnapshot = {
        etag: response.headers.get("etag"),
        fetchedAt: this.#now(),
        models: parseCatalogPayload(await response.json()),
      };
      this.#cache.set(input.cacheKey, snapshot);
      return snapshot;
    })();
    this.#inFlight.set(input.cacheKey, refresh);
    const clear = () => {
      if (this.#inFlight.get(input.cacheKey) === refresh) {
        this.#inFlight.delete(input.cacheKey);
      }
    };
    void refresh.then(clear, clear);
    return refresh;
  }
}

export class OpenRouterCatalogService {
  readonly #backgroundRefreshes = new Map<string, Promise<void>>();
  readonly #cache: OpenRouterCatalogCache;
  readonly #repository: ServerRepository;

  constructor(
    repository: ServerRepository,
    options: ConstructorParameters<typeof OpenRouterCatalogCache>[0] = {},
  ) {
    this.#repository = repository;
    this.#cache = new OpenRouterCatalogCache(options);
  }

  async getProviderCatalog(
    ownerId: string,
    providerId: string,
    force = false,
  ): Promise<ProviderModelCatalogResult | null> {
    const provider = await this.#repository.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
    if (!provider) return null;
    if (!isOpenRouterProvider(provider)) {
      throw new Error("Provider is not an OpenRouter-compatible provider.");
    }

    const startedAt = new Date();
    const scopes = provider.apiKey
      ? [OPENROUTER_GLOBAL_SCOPE, OPENROUTER_USER_SCOPE]
      : [OPENROUTER_GLOBAL_SCOPE];
    await Promise.all(
      scopes.map((scopeKey) =>
        this.#repository.setProviderCatalogSyncState(provider.id, {
          scopeKey,
          status: "refreshing",
          error: null,
          refreshStartedAt: startedAt,
        }),
      ),
    );

    try {
      const publicRead = await this.#cache.read({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        cacheKey: `public:${new URL(provider.baseUrl).origin}`,
        force,
        userScoped: false,
      });
      const userRead = provider.apiKey
        ? await this.#cache.read({
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            cacheKey: `user:${provider.id}`,
            force,
            userScoped: true,
          })
        : null;
      const servedStale =
        publicRead.servedStale || (userRead?.servedStale ?? false);
      await this.#persist(provider, publicRead.snapshot, userRead?.snapshot);
      await this.#recordSuccess(
        provider,
        publicRead.snapshot,
        userRead?.snapshot,
        servedStale,
      );

      const background = [
        publicRead.backgroundRefresh,
        userRead?.backgroundRefresh ?? null,
      ].filter((refresh): refresh is Promise<CatalogSnapshot> =>
        Boolean(refresh),
      );
      if (background.length > 0) {
        this.#scheduleBackgroundPersistence(ownerId, providerId, background);
      }
      return this.#repository.getProviderModelCatalog(
        ownerId,
        providerId,
        servedStale,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all(
        scopes.map((scopeKey) =>
          this.#repository.setProviderCatalogSyncState(provider.id, {
            scopeKey,
            status: "failed",
            error: message,
          }),
        ),
      );
      throw error;
    }
  }

  async #persist(
    provider: ModelProviderCatalogRuntime,
    publicSnapshot: CatalogSnapshot,
    userSnapshot?: CatalogSnapshot,
  ): Promise<void> {
    const normalized = publicSnapshot.models.map(normalizeOpenRouterModel);
    const publicIds = new Set(normalized.map((model) => model.nativeModelId));
    await this.#repository.reconcileProviderModelCatalog(
      provider.ownerId,
      provider.id,
      {
        models: normalized,
        availabilityScope: OPENROUTER_GLOBAL_SCOPE,
        availableNativeModelIds: publicIds,
      },
    );
    if (userSnapshot) {
      await this.#repository.reconcileProviderModelCatalog(
        provider.ownerId,
        provider.id,
        {
          models: normalized,
          availabilityScope: OPENROUTER_USER_SCOPE,
          availableNativeModelIds: new Set(
            userSnapshot.models.map((model) => model.id),
          ),
        },
      );
    }
  }

  async #recordSuccess(
    provider: ModelProviderCatalogRuntime,
    publicSnapshot: CatalogSnapshot,
    userSnapshot: CatalogSnapshot | undefined,
    servedStale: boolean,
  ): Promise<void> {
    const now = new Date();
    await this.#repository.setProviderCatalogSyncState(provider.id, {
      scopeKey: OPENROUTER_GLOBAL_SCOPE,
      status: servedStale ? "stale" : "current",
      error: null,
      etag: publicSnapshot.etag,
      ...(servedStale ? {} : { lastSuccessAt: now }),
    });
    if (userSnapshot) {
      await this.#repository.setProviderCatalogSyncState(provider.id, {
        scopeKey: OPENROUTER_USER_SCOPE,
        status: servedStale ? "stale" : "current",
        error: null,
        etag: userSnapshot.etag,
        ...(servedStale ? {} : { lastSuccessAt: now }),
      });
    }
  }

  #scheduleBackgroundPersistence(
    ownerId: string,
    providerId: string,
    refreshes: Promise<CatalogSnapshot>[],
  ): void {
    if (this.#backgroundRefreshes.has(providerId)) return;
    const refresh = Promise.all(refreshes)
      .then(async () => {
        await this.getProviderCatalog(ownerId, providerId, false);
      })
      .catch(async (error: unknown) => {
        await this.#repository.setProviderCatalogSyncState(providerId, {
          scopeKey: OPENROUTER_GLOBAL_SCOPE,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.#backgroundRefreshes.get(providerId) === refresh) {
          this.#backgroundRefreshes.delete(providerId);
        }
      });
    this.#backgroundRefreshes.set(providerId, refresh);
  }
}
