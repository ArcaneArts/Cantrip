import {
  providerAccessTokenLeaseRequestSchema,
  providerAccessTokenLeaseSchema,
  providerCredentialWireRecordSchema,
  type ProviderAccessTokenLease,
} from "@cantrip/protocol";
import { providerCredentialUploadSchema } from "@cantrip/protocol/protected-secrets";

import type { WorkerConfig } from "./config.js";
import { workerLogger } from "./logger.js";
import {
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRequiresSignInError,
  refreshProviderCredential,
} from "./provider-credential-refresh.js";
import {
  openProviderCredential,
  protectProviderCredential,
} from "./protected-secrets.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

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
      `Cantrip could not obtain a provider access lease (HTTP ${status}${code ? `, ${code}` : ""}).`,
    );
    this.name = "ProviderAccessTokenRequestError";
  }
}

/**
 * Fetches an opaque worker-scoped credential, opens and refreshes it inside
 * this authorized worker, and retains the resulting access lease in memory.
 * Any refreshed durable credential is sealed again before upload.
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
    private readonly encryption: WorkerEncryptionService,
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
      `/api/internal/workers/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(providerAccountId)}/credential`,
      this.config.serverUrl,
    );
    url.searchParams.set("workerId", this.config.workerId);
    let response = await this.#fetch(url, {
      headers: {
        authorization: `Bearer ${this.config.token}`,
      },
      method: "GET",
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
    let record = providerCredentialWireRecordSchema.parse(
      await response.json(),
    );
    let credential = await openProviderCredential({
      accountId: providerAccountId,
      credential: record.credential,
      service: this.encryption,
    });
    if (credential.kind !== record.providerKind) {
      throw new ProviderAccessTokenRequestError(409, "identity-conflict");
    }
    const requiresRefresh =
      request.forceRefresh ||
      (credential.expiresAt !== null &&
        credential.expiresAt <=
          this.#now() + request.minimumValiditySeconds * 1_000);
    if (requiresRefresh) {
      try {
        credential = await refreshProviderCredential(
          credential,
          AbortSignal.timeout(this.#requestTimeoutMs),
        );
      } catch (error) {
        throw new ProviderAccessTokenRequestError(
          409,
          error instanceof ProviderCredentialRequiresSignInError
            ? "reauth-required"
            : error instanceof ProviderCredentialIdentityConflictError
              ? "identity-conflict"
              : "refresh-failed",
        );
      }
      const protectedReplacement = await protectProviderCredential({
        accountId: providerAccountId,
        credential,
        service: this.encryption,
      });
      response = await this.#fetch(url, {
        body: JSON.stringify(
          providerCredentialUploadSchema.parse({
            ...protectedReplacement,
            expectedRevision: record.credentialRevision,
          }),
        ),
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        method: "PUT",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if (response.status === 409) {
        const staleRevision = record.credentialRevision;
        response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${this.config.token}` },
          method: "GET",
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        if (!response.ok) {
          throw new ProviderAccessTokenRequestError(
            response.status,
            "refresh-failed",
          );
        }
        record = providerCredentialWireRecordSchema.parse(
          await response.json(),
        );
        if (record.credentialRevision <= staleRevision) {
          throw new ProviderAccessTokenRequestError(409, "refresh-failed");
        }
        credential = await openProviderCredential({
          accountId: providerAccountId,
          credential: record.credential,
          service: this.encryption,
        });
        if (
          credential.kind !== record.providerKind ||
          (credential.expiresAt !== null &&
            credential.expiresAt <=
              this.#now() + request.minimumValiditySeconds * 1_000)
        ) {
          throw new ProviderAccessTokenRequestError(409, "refresh-failed");
        }
      } else if (!response.ok) {
        throw new ProviderAccessTokenRequestError(response.status, null);
      } else {
        record = providerCredentialWireRecordSchema.parse(
          await response.json(),
        );
      }
    }
    const issuedAt = new Date(this.#now());
    const lease = providerAccessTokenLeaseSchema.parse({
      accessToken: credential.accessToken,
      credentialRevision: record.credentialRevision,
      expiresAt: credential.expiresAt
        ? new Date(credential.expiresAt).toISOString()
        : null,
      email: credential.email,
      issuedAt: issuedAt.toISOString(),
      leaseExpiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
      planType: credential.planType,
      providerAccountId,
      providerId,
      providerIdentity:
        credential.kind === "chatgpt"
          ? {
              accountId: credential.accountId,
              kind: "chatgpt",
              userId: credential.userId,
            }
          : { kind: "grok", userId: credential.userId },
      providerKind: credential.kind,
    });
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
