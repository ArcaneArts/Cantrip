import {
  providerAccessTokenLeaseRequestSchema,
  providerAccessTokenLeaseSchema,
  type ProviderAccessTokenLease,
} from "@cantrip/protocol";

import type { WorkerConfig } from "./config.js";

const CACHE_EXPIRY_BUFFER_MS = 30_000;

export interface ProviderAccessTokenClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Fetches worker-scoped access leases and retains them in memory only. Durable
 * provider credentials remain exclusively on the Cantrip server.
 */
export class ProviderAccessTokenClient {
  readonly #cache = new Map<string, ProviderAccessTokenLease>();
  readonly #fetch: typeof fetch;
  readonly #inflight = new Map<string, Promise<ProviderAccessTokenLease>>();
  readonly #now: () => number;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      "serverUrl" | "token" | "workerId"
    >,
    options: ProviderAccessTokenClientOptions = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async get(
    providerId: string,
    providerAccountId: string,
    options: { forceRefresh?: boolean; minimumValiditySeconds?: number } = {},
  ): Promise<ProviderAccessTokenLease> {
    const request = providerAccessTokenLeaseRequestSchema.parse({
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
      return cached;
    }
    const requestKey = `${key}:${request.forceRefresh ? "refresh" : "lease"}`;
    const existing = this.#inflight.get(requestKey);
    if (existing) return existing;
    const pending = this.#request(
      providerId,
      providerAccountId,
      request,
    ).finally(() => {
      if (this.#inflight.get(requestKey) === pending) {
        this.#inflight.delete(requestKey);
      }
    });
    this.#inflight.set(requestKey, pending);
    const lease = await pending;
    this.#cache.set(key, lease);
    return lease;
  }

  clear(providerId?: string, providerAccountId?: string): void {
    if (!providerId) {
      this.#cache.clear();
      return;
    }
    if (providerAccountId) {
      this.#cache.delete(`${providerId}:${providerAccountId}`);
      return;
    }
    for (const key of this.#cache.keys()) {
      if (key.startsWith(`${providerId}:`)) this.#cache.delete(key);
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
    request: { forceRefresh: boolean; minimumValiditySeconds: number },
  ): Promise<ProviderAccessTokenLease> {
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
    });
    if (!response.ok) {
      throw new Error(
        `Cantrip Server could not issue a provider access lease (HTTP ${response.status}).`,
      );
    }
    return providerAccessTokenLeaseSchema.parse(await response.json());
  }
}
