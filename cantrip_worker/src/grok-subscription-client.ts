import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  grokModelInventorySchema,
  providerQuotaSnapshotSchema,
  type GrokModelInventory,
  type GrokModelInventoryItem,
  type ProviderQuotaSnapshot,
  type ProviderWeeklyUsage,
} from "@cantrip/protocol";

import { workerLogger } from "./logger.js";

export const GROK_SUBSCRIPTION_PROXY = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLIENT_VERSION = "1.0.3";

const MAX_PROXY_REQUEST_BYTES = 64 * 1_024 * 1_024;
const WEEKLY_USAGE_CACHE_MS = 30_000;
const WEEKLY_USAGE_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";
const REASONING_DECODE_FAILURE_MARKERS = [
  "could not decode the compaction blob",
  "could not decrypt the provided encrypted_content",
] as const;

export interface GrokSubscriptionAccess {
  accessToken: string;
  credentialRevision?: number;
  email: string | null;
  userId: string;
}

export interface GrokSubscriptionAccessRequest {
  credentialRevision?: number;
  forceRefresh?: boolean;
}

export type GrokSubscriptionAccessSource = (
  request?: GrokSubscriptionAccessRequest,
) => Promise<GrokSubscriptionAccess>;

export interface GrokSubscriptionClientOptions {
  clientVersion?: string;
  fetch?: typeof fetch;
  now?: () => number;
  proxyBaseUrl?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function numberField(
  value: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
      return candidate > 0 ? candidate : null;
    }
  }
  return null;
}

function booleanField(
  value: Record<string, unknown>,
  ...keys: string[]
): boolean | null {
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key];
  }
  return null;
}

function stringArrayField(
  value: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) continue;
    return candidate.filter(
      (entry): entry is string =>
        typeof entry === "string" && Boolean(entry.trim()),
    );
  }
  return [];
}

function objectField(
  value: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    const candidate = value[key];
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
    ) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

function normalizedModalities(...candidates: string[][]): string[] {
  return [
    ...new Set(
      candidates
        .find((candidate) => candidate.length > 0)
        ?.map((modality) => modality.trim().toLowerCase()) ?? [],
    ),
  ];
}

function normalizeReasoningEfforts(
  value: Record<string, unknown>,
  meta: Record<string, unknown>,
): GrokModelInventoryItem["supportedReasoningEfforts"] {
  const raw =
    value.reasoningEfforts ??
    value.reasoning_efforts ??
    meta.reasoningEfforts ??
    meta.reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  const efforts = new Map<string, string | null>();
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) efforts.set(entry.trim(), null);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const effort = stringField(record, "value", "effort", "id");
    if (!effort) continue;
    efforts.set(effort, stringField(record, "description", "label"));
  }
  return [...efforts].map(([effort, description]) => ({ effort, description }));
}

export function normalizeGrokModel(
  input: unknown,
): GrokModelInventoryItem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const meta =
    value._meta &&
    typeof value._meta === "object" &&
    !Array.isArray(value._meta)
      ? (value._meta as Record<string, unknown>)
      : {};
  const id =
    stringField(value, "model", "modelId", "id") ??
    stringField(meta, "model", "modelId", "id");
  if (!id) return null;
  const efforts = normalizeReasoningEfforts(value, meta);
  const defaultReasoningEffort =
    stringField(value, "reasoningEffort", "reasoning_effort") ??
    stringField(meta, "reasoningEffort", "reasoning_effort");
  const architecture = objectField(value, "architecture");
  const metaArchitecture = objectField(meta, "architecture");
  const capabilities = objectField(value, "capabilities");
  const metaCapabilities = objectField(meta, "capabilities");
  const inputModalities = normalizedModalities(
    stringArrayField(value, "inputModalities", "input_modalities"),
    stringArrayField(meta, "inputModalities", "input_modalities"),
    stringArrayField(architecture, "inputModalities", "input_modalities"),
    stringArrayField(metaArchitecture, "inputModalities", "input_modalities"),
  );
  const outputModalities = normalizedModalities(
    stringArrayField(value, "outputModalities", "output_modalities"),
    stringArrayField(meta, "outputModalities", "output_modalities"),
    stringArrayField(architecture, "outputModalities", "output_modalities"),
    stringArrayField(metaArchitecture, "outputModalities", "output_modalities"),
  );
  const supportsVision =
    booleanField(
      value,
      "supportsVision",
      "supports_vision",
      "supportsImageInput",
      "supports_image_input",
    ) ??
    booleanField(
      meta,
      "supportsVision",
      "supports_vision",
      "supportsImageInput",
      "supports_image_input",
    ) ??
    booleanField(
      capabilities,
      "vision",
      "image",
      "imageInput",
      "image_input",
    ) ??
    booleanField(
      metaCapabilities,
      "vision",
      "image",
      "imageInput",
      "image_input",
    );
  if (supportsVision === true) {
    if (inputModalities.length === 0) inputModalities.push("text");
    if (!inputModalities.includes("image")) inputModalities.push("image");
  }
  return grokModelInventorySchema.shape.models.element.parse({
    id,
    displayName: stringField(value, "name", "displayName") ?? id,
    description: stringField(value, "description"),
    contextWindow:
      numberField(value, "contextWindow", "context_window") ??
      numberField(meta, "contextWindow", "totalContextTokens"),
    maxOutputTokens: numberField(
      value,
      "maxCompletionTokens",
      "max_completion_tokens",
      "maxOutputTokens",
      "max_output_tokens",
    ),
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    outputModalities: outputModalities.length ? outputModalities : ["text"],
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort,
    supportsReasoning:
      booleanField(
        value,
        "supportsReasoningEffort",
        "supports_reasoning_effort",
      ) ??
      booleanField(
        meta,
        "supportsReasoningEffort",
        "supports_reasoning_effort",
      ) ??
      Boolean(defaultReasoningEffort || efforts.length),
    hidden:
      booleanField(value, "hidden") ?? booleanField(meta, "hidden") ?? false,
    isDefault: booleanField(value, "isDefault", "is_default") ?? false,
    rawMetadata: value,
  });
}

/** Extracts the shared weekly subscription pool exposed by Grok Build. */
export function normalizeGrokWeeklyUsage(
  input: unknown,
): ProviderWeeklyUsage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const config = (input as Record<string, unknown>).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const value = config as Record<string, unknown>;
  const period = value.currentPeriod;
  if (!period || typeof period !== "object" || Array.isArray(period)) {
    return null;
  }
  const periodValue = period as Record<string, unknown>;
  if (periodValue.type !== WEEKLY_USAGE_PERIOD_TYPE) return null;
  // Proto3 JSON omits zero-valued scalar fields. An active weekly period with
  // no creditUsagePercent therefore represents 0% used, not missing quota.
  const usedPercent = value.creditUsagePercent ?? 0;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    return null;
  }
  const resetMilliseconds =
    typeof periodValue.end === "string"
      ? Date.parse(periodValue.end)
      : Number.NaN;
  return {
    usedPercent,
    resetsAt: Number.isFinite(resetMilliseconds)
      ? Math.floor(resetMilliseconds / 1_000)
      : null,
  };
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_PROXY_REQUEST_BYTES) {
      throw new Error("Grok proxy request exceeded 64 MiB.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function isReasoningDecodeFailure(errorBody: string): boolean {
  const normalized = errorBody.toLowerCase();
  return REASONING_DECODE_FAILURE_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
}

async function responseHasReasoningDecodeFailure(
  response: Response,
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    return isReasoningDecodeFailure(await response.clone().text());
  } catch {
    return false;
  }
}

function stripReasoningItems(body: Buffer | undefined): Buffer | null {
  if (!body?.byteLength) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(payload.input)) return null;
  let changed = false;
  const input = payload.input.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [entry];
    }
    const item = entry as Record<string, unknown>;
    // Grok accepts replayed reasoning only with the exact encrypted payload it
    // produced. Once that payload is rejected, retaining a summary-only item
    // produces a 422 because it is not a valid ModelInput variant.
    if (item.type !== "reasoning") return [entry];
    changed = true;
    return [];
  });
  if (!changed) return null;
  return Buffer.from(JSON.stringify({ ...payload, input }));
}

function removePromptCacheKey(body: Buffer | undefined): Buffer | null {
  if (!body?.byteLength) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const payload = parsed as Record<string, unknown>;
    delete payload.prompt_cache_key;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return null;
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The replacement response remains authoritative even if cleanup races.
  }
}

interface GrokProxyRequestIdentity {
  conversationId: string;
  modelId: string | null;
  requestId: string;
  sessionId: string;
}

function proxyRequestIdentity(
  body: Buffer | undefined,
  fallbackConversationId: string,
): GrokProxyRequestIdentity {
  let payload: Record<string, unknown> = {};
  if (body?.byteLength) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve and forward non-JSON request bodies without modification.
    }
  }
  const clientMetadata =
    payload.client_metadata &&
    typeof payload.client_metadata === "object" &&
    !Array.isArray(payload.client_metadata)
      ? (payload.client_metadata as Record<string, unknown>)
      : {};
  const promptCacheKey =
    typeof payload.prompt_cache_key === "string" &&
    payload.prompt_cache_key.trim()
      ? payload.prompt_cache_key.trim()
      : null;
  // Grok Build uses one canonical session value for prompt_cache_key,
  // x-grok-conv-id, and x-grok-session-id. Codex exposes both a long-lived
  // session ID and a thread ID, but its prompt cache key is the session ID.
  // Mixing the thread ID into only x-grok-conv-id lets the first response
  // succeed while making Grok reject its encrypted reasoning state on the
  // following tool continuation.
  const conversationId =
    promptCacheKey ??
    stringField(clientMetadata, "session_id", "thread_id") ??
    fallbackConversationId;
  return {
    conversationId,
    modelId:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : null,
    requestId: stringField(clientMetadata, "turn_id") ?? randomUUID(),
    sessionId: conversationId,
  };
}

/**
 * Talks to xAI's subscription API using an injected access-token source. The
 * source may be legacy local storage or a server lease; proxy and header
 * behavior remain identical in either case.
 */
export class GrokSubscriptionClient {
  readonly #agentId = randomUUID();
  readonly #clientVersion: string;
  readonly #fallbackConversationId = randomUUID();
  readonly #fetch: typeof fetch;
  readonly #nextTurnIndexByConversation = new Map<string, number>();
  readonly #now: () => number;
  readonly #proxyBaseUrl: string;
  readonly #proxyPathToken = randomUUID();
  readonly #statelessConversations = new Set<string>();
  readonly #statelessRequestIdByTurn = new Map<string, string>();
  readonly #turnIndexByRequest = new Map<string, number>();
  #proxyServer: Server | null = null;
  #proxyStarting: Promise<string> | null = null;
  #weeklyUsageCache: {
    fetchedAt: number;
    snapshot: ProviderQuotaSnapshot | null;
    value: ProviderWeeklyUsage | null;
  } | null = null;

  constructor(
    private readonly access: GrokSubscriptionAccessSource,
    options: GrokSubscriptionClientOptions = {},
  ) {
    this.#clientVersion =
      options.clientVersion ??
      (process.env.CANTRIP_GROK_CLIENT_VERSION?.trim() || GROK_CLIENT_VERSION);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#proxyBaseUrl = (
      options.proxyBaseUrl ?? GROK_SUBSCRIPTION_PROXY
    ).replace(/\/+$/u, "");
  }

  async listModels(): Promise<GrokModelInventory> {
    const response = await this.request("/models", {}, true);
    if (!response.ok) {
      throw new Error(`Grok model discovery failed (${response.status}).`);
    }
    const payload = (await response.json()) as { data?: unknown[] };
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map(normalizeGrokModel)
      .filter((model): model is GrokModelInventoryItem => Boolean(model));
    if (!models.some(({ isDefault }) => isDefault)) {
      const first = models.find(({ hidden }) => !hidden);
      if (first) first.isDefault = true;
    }
    return grokModelInventorySchema.parse({
      models,
      observedAt: new Date(this.#now()).toISOString(),
    });
  }

  async weeklyUsage(): Promise<ProviderWeeklyUsage | null> {
    const snapshot = await this.quotaSnapshot();
    const weekly = snapshot?.windows.find(
      (window) => window.isWeeklyProjection,
    );
    return weekly
      ? { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }
      : null;
  }

  async quotaSnapshot(
    forceRefresh = false,
  ): Promise<ProviderQuotaSnapshot | null> {
    if (
      !forceRefresh &&
      this.#weeklyUsageCache &&
      this.#now() - this.#weeklyUsageCache.fetchedAt < WEEKLY_USAGE_CACHE_MS
    ) {
      return this.#weeklyUsageCache.snapshot;
    }
    try {
      const response = await this.request("/billing?format=credits");
      if (!response.ok) {
        throw new Error(`Grok usage discovery failed (${response.status}).`);
      }
      const value = normalizeGrokWeeklyUsage(await response.json());
      const fetchedAt = this.#now();
      const snapshot = value
        ? providerQuotaSnapshotSchema.parse({
            snapshotId: randomUUID(),
            observedAt: new Date(fetchedAt).toISOString(),
            workerVersion: null,
            codexVersion: null,
            windows: [
              {
                limitId: "grok-subscription",
                limitName: "Grok subscription credits",
                planType: null,
                reachedType: value.usedPercent >= 100 ? "exhausted" : null,
                windowKind: "primary",
                usedPercent: value.usedPercent,
                windowDurationMinutes: 7 * 24 * 60,
                resetsAt: value.resetsAt,
                isWeeklyProjection: true,
                rawPayload: {
                  source: "billing-credits",
                  usedPercent: value.usedPercent,
                  resetsAt: value.resetsAt,
                },
              },
            ],
          })
        : null;
      this.#weeklyUsageCache = { fetchedAt, snapshot, value };
      return snapshot;
    } catch (error) {
      workerLogger.rateLimited(
        "grok-quota-refresh-failed",
        "warn",
        "Grok quota refresh failed",
        {
          event: "provider.quota.refresh",
          subsystem: "provider",
          operation: "grok-quota",
          reasonCode: "request-failed",
          status: "failed",
          providerKind: "grok",
          error,
        },
      );
      return this.#weeklyUsageCache?.snapshot ?? null;
    }
  }

  async localProxyBaseUrl(): Promise<string> {
    if (this.#proxyServer) {
      const address = this.#proxyServer.address();
      if (address && typeof address !== "string") {
        return `http://127.0.0.1:${address.port}/${this.#proxyPathToken}/v1`;
      }
    }
    this.#proxyStarting ??= this.#startProxy();
    try {
      return await this.#proxyStarting;
    } finally {
      this.#proxyStarting = null;
    }
  }

  close(): void {
    this.#proxyServer?.close();
    this.#proxyServer = null;
    this.#nextTurnIndexByConversation.clear();
    this.#statelessConversations.clear();
    this.#statelessRequestIdByTurn.clear();
    this.#turnIndexByRequest.clear();
    this.#weeklyUsageCache = null;
  }

  async request(
    resource: string,
    init: RequestInit = {},
    retryUnauthorized = true,
  ): Promise<Response> {
    let credential = await this.access();
    const target = resource.startsWith("http")
      ? new URL(resource)
      : new URL(resource.replace(/^\//u, ""), `${this.#proxyBaseUrl}/`);
    if (target.origin !== new URL(this.#proxyBaseUrl).origin) {
      throw new Error(
        "Grok credential forwarding escaped the subscription proxy.",
      );
    }
    let response = await this.#fetch(target, {
      ...init,
      headers: this.#authHeaders(credential, init.headers),
    });
    if (response.status === 401 && retryUnauthorized) {
      credential = await this.access({
        credentialRevision: credential.credentialRevision,
        forceRefresh: true,
      });
      response = await this.#fetch(target, {
        ...init,
        headers: this.#authHeaders(credential, init.headers),
      });
    }
    return response;
  }

  #authHeaders(
    credential: GrokSubscriptionAccess,
    initial?: HeadersInit,
  ): Headers {
    const headers = new Headers(initial);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("x-xai-token-auth", "xai-grok-cli");
    headers.set("x-grok-client-version", this.#clientVersion);
    headers.set("x-grok-client-identifier", "cantrip");
    headers.set("x-grok-client-mode", "interactive");
    headers.set("x-authenticateresponse", "authenticate-response");
    if (credential.userId) {
      headers.set("x-userid", credential.userId);
      headers.set("x-grok-user-id", credential.userId);
    }
    if (credential.email) headers.set("x-email", credential.email);
    return headers;
  }

  async #startProxy(): Promise<string> {
    await this.access();
    const server = createServer((request, response) => {
      void this.#handleProxyRequest(request)
        .then(async (upstream) => {
          response.statusCode = upstream.status;
          for (const [name, value] of upstream.headers) {
            if (
              [
                "connection",
                "content-encoding",
                "content-length",
                "transfer-encoding",
              ].includes(name.toLowerCase())
            ) {
              continue;
            }
            response.setHeader(name, value);
          }
          if (!upstream.body) {
            response.end();
            return;
          }
          await pipeline(Readable.fromWeb(upstream.body as never), response);
        })
        .catch((error) => {
          if (response.headersSent) {
            response.destroy(error instanceof Error ? error : undefined);
            return;
          }
          const oversized = errorMessage(error).includes("64 MiB");
          response.statusCode = oversized ? 413 : 502;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              error: oversized
                ? "Grok proxy request exceeded 64 MiB."
                : "Grok subscription proxy request failed.",
            }),
          );
        });
    });
    this.#proxyServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      this.#proxyServer = null;
      throw new Error("Could not bind the local Grok credential proxy.");
    }
    return `http://127.0.0.1:${address.port}/${this.#proxyPathToken}/v1`;
  }

  async #handleProxyRequest(request: IncomingMessage): Promise<Response> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const localPrefix = `/${this.#proxyPathToken}/v1/`;
    if (!requestUrl.pathname.startsWith(localPrefix)) {
      throw new Error("Grok proxy rejected a path outside /v1.");
    }
    const upstreamPath = `/v1/${requestUrl.pathname.slice(localPrefix.length)}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        [
          "authorization",
          "connection",
          "content-length",
          "host",
          "transfer-encoding",
          "x-authenticateresponse",
          "x-email",
          "x-grok-client-identifier",
          "x-grok-client-mode",
          "x-grok-client-version",
          "x-grok-conv-id",
          "x-grok-agent-id",
          "x-grok-model-override",
          "x-grok-req-id",
          "x-grok-session-id",
          "x-grok-turn-idx",
          "x-grok-user-id",
          "x-userid",
          "x-xai-token-auth",
        ].includes(name.toLowerCase())
      ) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = await readRequestBody(request);
    const identity = proxyRequestIdentity(body, this.#fallbackConversationId);
    const turnKey = `${identity.conversationId}\u0000${identity.requestId}`;
    const statelessConversation = this.#statelessConversations.has(
      identity.conversationId,
    );
    let turnIndex = this.#turnIndexByRequest.get(turnKey);
    if (turnIndex === undefined) {
      // Grok increments its prompt index before sampling, so mirror its
      // one-based sequence and retain that value across tool continuations.
      turnIndex =
        this.#nextTurnIndexByConversation.get(identity.conversationId) ?? 1;
      this.#turnIndexByRequest.set(turnKey, turnIndex);
      this.#nextTurnIndexByConversation.set(
        identity.conversationId,
        turnIndex + 1,
      );
    }
    // Grok binds encrypted reasoning state to this request identity. Keep it
    // stable across every model/tool continuation in the same Codex turn.
    headers.set("x-grok-agent-id", this.#agentId);
    if (statelessConversation) {
      let statelessRequestId = this.#statelessRequestIdByTurn.get(turnKey);
      if (!statelessRequestId) {
        statelessRequestId = randomUUID();
        this.#statelessRequestIdByTurn.set(turnKey, statelessRequestId);
      }
      headers.set("x-grok-req-id", statelessRequestId);
    } else {
      headers.set("x-grok-conv-id", identity.conversationId);
      headers.set("x-grok-req-id", identity.requestId);
      headers.set("x-grok-session-id", identity.sessionId);
      headers.set("x-grok-turn-idx", String(turnIndex));
    }
    if (identity.modelId) {
      headers.set("x-grok-model-override", identity.modelId);
    }
    const target = `${new URL(this.#proxyBaseUrl).origin}${upstreamPath}${requestUrl.search}`;
    const initialBody = statelessConversation
      ? removePromptCacheKey(stripReasoningItems(body) ?? body)
      : body;
    const initial = await this.request(
      target,
      {
        method: request.method,
        headers,
        body: initialBody as BodyInit | undefined,
      },
      true,
    );
    if (statelessConversation) return initial;
    if (!(await responseHasReasoningDecodeFailure(initial))) return initial;

    const portableBody = stripReasoningItems(body);
    let rejected = initial;
    if (portableBody) {
      workerLogger.warn(
        "Grok rejected opaque reasoning state; retrying without reasoning history",
        {
          conversationId: identity.conversationId,
          requestId: identity.requestId,
        },
      );
      await discardResponse(rejected);
      const portable = await this.request(
        target,
        {
          method: request.method,
          headers,
          body: portableBody as BodyInit,
        },
        true,
      );
      if (!(await responseHasReasoningDecodeFailure(portable))) return portable;
      rejected = portable;
    }

    const statelessBody = removePromptCacheKey(portableBody ?? body);
    if (!statelessBody) return rejected;
    await discardResponse(rejected);
    const statelessHeaders = new Headers(headers);
    statelessHeaders.delete("x-grok-conv-id");
    statelessHeaders.delete("x-grok-session-id");
    statelessHeaders.delete("x-grok-turn-idx");
    const statelessRequestId = randomUUID();
    statelessHeaders.set("x-grok-req-id", statelessRequestId);
    workerLogger.warn(
      "Grok reasoning recovery remained session-bound; retrying statelessly",
      { conversationId: identity.conversationId },
    );
    const stateless = await this.request(
      target,
      {
        method: request.method,
        headers: statelessHeaders,
        body: statelessBody as BodyInit,
      },
      true,
    );
    if (stateless.ok) {
      this.#statelessConversations.add(identity.conversationId);
      this.#statelessRequestIdByTurn.set(turnKey, statelessRequestId);
    }
    return stateless;
  }
}
