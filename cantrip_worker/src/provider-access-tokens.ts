import {
  providerAccessTokenLeaseRequestSchema,
  providerAccessTokenLeaseSchema,
  type ProviderAccessTokenLease,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";
import { workerLogger } from "./logger.js";

const CACHE_EXPIRY_BUFFER_MS = 30_000;

export interface ProviderAccessTokenClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

export type ProviderAccessTokenRequestErrorCode =
  | "credential-unavailable"
  | "migration-needed"
  | "reauth-required"
  | "identity-conflict"
  | "refresh-unavailable"
  | "refresh-failed"
  | "refresh-timeout";

const ERROR_CODES = new Set<ProviderAccessTokenRequestErrorCode>([
  "credential-unavailable",
  "migration-needed",
  "reauth-required",
  "identity-conflict",
  "refresh-unavailable",
  "refresh-failed",
  "refresh-timeout",
]);

export class ProviderAccessTokenRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProviderAccessTokenRequestErrorCode | null,
  ) {
    super(
      `Cantrip Server could not issue a provider access lease (HTTP ${status}${code ? `, ${code}` : ""}).`,
    );
    this.name = "ProviderAccessTokenRequestError";
  }
}

/**
 * Fetches worker-scoped access leases and retains them in memory only. Durable
 * provider credentials remain exclusively on the Cantrip server.
 */
export class ProviderAccessTokenClient {
  readonly #cache = new Map<string, ProviderAccessTokenLease>();
  readonly #fetch: typeof fetch;
  readonly #generations = new Map<string, number>();
  #globalGeneration = 0;
  readonly #inflight = new Map<
    string,
    {
      accountKey: string;
      generation: string;
      promise: Promise<ProviderAccessTokenLease>;
    }
  >();
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      "serverUrl" | "token" | "workerId"
    >,
    options: ProviderAccessTokenClientOptions = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 9_000;
  }

  async get(
    providerId: string,
    providerAccountId: string,
    options: {
      credentialRevision?: number;
      forceRefresh?: boolean;
      minimumValiditySeconds?: number;
    } = {},
  ): Promise<ProviderAccessTokenLease> {
    const request = providerAccessTokenLeaseRequestSchema.parse({
      credentialRevision: options.forceRefresh
        ? (options.credentialRevision ??
          this.#cache.get(`${providerId}:${providerAccountId}`)
            ?.credentialRevision ??
          null)
        : null,
      forceRefresh: options.forceRefresh,
      minimumValiditySeconds: options.minimumValiditySeconds,
    });
    const key = `${providerId}:${providerAccountId}`;
    const cached = this.#cache.get(key);
    if (
      !request.forceRefresh &&
      cached &&
      this.#usable(cached, request.minimumValiditySeconds)
    ) {
      workerLogger.sampled(
        `provider-access-cache-hit:${providerId}:${providerAccountId}`,
        20,
        "debug",
        "Provider access lease cache hit",
        {
          event: "provider.access-lease.cache-hit",
          subsystem: "provider-auth",
          operation: "lease",
          status: "cached",
          providerId,
          accountId: providerAccountId,
        },
      );
      return cached;
    }
    const requestKey = request.forceRefresh
      ? `${key}:refresh:${request.credentialRevision ?? "unknown"}`
      : `${key}:lease`;
    const generation = this.#generationFor(key);
    const existing = this.#inflight.get(requestKey);
    if (existing?.generation === generation) {
      workerLogger.sampled(
        `provider-access-inflight:${providerId}:${providerAccountId}`,
        20,
        "debug",
        "Provider access lease request joined in flight",
        {
          event: "provider.access-lease.joined",
          subsystem: "provider-auth",
          operation: "lease",
          status: "pending",
          providerId,
          accountId: providerAccountId,
        },
      );
      return existing.promise;
    }
    const pending = this.#request(providerId, providerAccountId, request)
      .then((lease) => {
        if (this.#generationFor(key) !== generation) {
          throw new ProviderAccessTokenRequestError(
            409,
            "credential-unavailable",
          );
        }
        return lease;
      })
      .finally(() => {
        if (this.#inflight.get(requestKey)?.promise === pending) {
          this.#inflight.delete(requestKey);
        }
      });
    this.#inflight.set(requestKey, {
      accountKey: key,
      generation,
      promise: pending,
    });
    const lease = await pending;
    const current = this.#cache.get(key);
    if (!current || lease.credentialRevision >= current.credentialRevision) {
      this.#cache.set(key, lease);
    }
    return lease;
  }

  clear(providerId?: string, providerAccountId?: string): void {
    if (!providerId) {
      this.#globalGeneration += 1;
      this.#cache.clear();
      this.#inflight.clear();
      workerLogger.event("debug", "Provider access lease cache cleared", {
        event: "provider.access-lease.cache-cleared",
        subsystem: "provider-auth",
        operation: "clear-leases",
        status: "completed",
        counts: { providers: 0 },
      });
      return;
    }
    if (providerAccountId) {
      this.#invalidate(`${providerId}:${providerAccountId}`);
      return;
    }
    const prefix = `${providerId}:`;
    const keys = new Set([
      ...this.#cache.keys(),
      ...this.#generations.keys(),
      ...[...this.#inflight.values()].map(({ accountKey }) => accountKey),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix)) this.#invalidate(key);
    }
  }

  #generationFor(key: string): string {
    return `${this.#globalGeneration}:${this.#generations.get(key) ?? 0}`;
  }

  #invalidate(key: string): void {
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.#cache.delete(key);
    for (const [requestKey, request] of this.#inflight) {
      if (request.accountKey === key) this.#inflight.delete(requestKey);
    }
  }

  #usable(
    lease: ProviderAccessTokenLease,
    minimumValiditySeconds: number,
  ): boolean {
    const now = this.#now();
    return (
      Date.parse(lease.leaseExpiresAt) > now + CACHE_EXPIRY_BUFFER_MS &&
      (lease.expiresAt === null ||
        Date.parse(lease.expiresAt) > now + minimumValiditySeconds * 1_000)
    );
  }

  async #request(
    providerId: string,
    providerAccountId: string,
    request: {
      credentialRevision: number | null;
      forceRefresh: boolean;
      minimumValiditySeconds: number;
    },
  ): Promise<ProviderAccessTokenLease> {
    const startedAtMs = this.#now();
    const url = new URL(
      `/api/internal/workers/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(providerAccountId)}/access-lease`,
      this.config.serverUrl,
    );
    url.searchParams.set("workerId", this.config.workerId);
    const response = await this.#fetch(url, {
      body: JSON.stringify(request),
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      let code: ProviderAccessTokenRequestErrorCode | null = null;
      try {
        const body = (await response.json()) as { code?: unknown };
        if (
          typeof body.code === "string" &&
          ERROR_CODES.has(body.code as ProviderAccessTokenRequestErrorCode)
        ) {
          code = body.code as ProviderAccessTokenRequestErrorCode;
        }
      } catch {
        // Error response bodies may contain provider details; never echo them.
      }
      const error = new ProviderAccessTokenRequestError(response.status, code);
      workerLogger.rateLimited(
        `provider-access-failed:${providerId}:${providerAccountId}:${response.status}:${code ?? "unknown"}`,
        "warn",
        "Provider access lease request failed",
        {
          event: "provider.access-lease.failed",
          subsystem: "provider-auth",
          operation: request.forceRefresh ? "refresh-lease" : "lease",
          reasonCode: code ?? `http-${response.status}`,
          status: "failed",
          durationMs: Math.max(0, this.#now() - startedAtMs),
          workerId: this.config.workerId,
          providerId,
          accountId: providerAccountId,
          httpStatus: response.status,
        },
      );
      throw error;
    }
    const lease = providerAccessTokenLeaseSchema.parse(await response.json());
    workerLogger.sampled(
      `provider-access-completed:${providerId}:${providerAccountId}`,
      20,
      "debug",
      "Provider access lease issued to worker",
      {
        event: "provider.access-lease.completed",
        subsystem: "provider-auth",
        operation: request.forceRefresh ? "refresh-lease" : "lease",
        status: "completed",
        durationMs: Math.max(0, this.#now() - startedAtMs),
        workerId: this.config.workerId,
        providerId,
        accountId: providerAccountId,
        credentialRevision: lease.credentialRevision,
      },
    );
    return lease;
  }
}
