import { randomUUID } from "node:crypto";

import type { ProviderAccessTokenLease } from "@cantrip/protocol";

import {
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  type ProviderAccountCredentialRecord,
  type ServerRepository,
} from "../db/repository.js";
import {
  parseProviderCredential,
  type ProviderCredential,
  type ProviderCredentialKind,
} from "./provider-credentials.js";

const DEFAULT_ACCESS_LEASE_DURATION_MS = 5 * 60_000;
const DEFAULT_REFRESH_LEASE_DURATION_MS = 30_000;
const DEFAULT_REFRESH_WAIT_MS = 35_000;
const REFRESH_POLL_MS = 100;

export type ProviderAccessTokenErrorCode =
  | "credential-unavailable"
  | "migration-needed"
  | "reauth-required"
  | "identity-conflict"
  | "refresh-unavailable"
  | "refresh-failed"
  | "refresh-timeout";

const ERROR_MESSAGES = {
  "credential-unavailable":
    "This provider account does not have a server credential.",
  "migration-needed":
    "This provider account must be migrated from a connected worker.",
  "reauth-required": "This provider account requires sign-in.",
  "identity-conflict":
    "This provider account has a conflicting OAuth identity.",
  "refresh-unavailable":
    "Credential refresh is not available for this provider.",
  "refresh-failed": "Provider credential refresh failed.",
  "refresh-timeout": "Timed out waiting for provider credential refresh.",
} as const satisfies Record<ProviderAccessTokenErrorCode, string>;

export class ProviderAccessTokenError extends Error {
  constructor(readonly code: ProviderAccessTokenErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProviderAccessTokenError";
  }
}

/** Refresh implementations return a complete replacement credential. */
export interface ProviderCredentialRefresher {
  refresh(
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<ProviderCredential>;
}

/** Refresh adapters use this to distinguish invalid grants from outages. */
export class ProviderCredentialRequiresSignInError extends Error {
  constructor() {
    super("Provider credential requires sign-in.");
    this.name = "ProviderCredentialRequiresSignInError";
  }
}

export interface ProviderAccessTokenServiceOptions {
  accessLeaseDurationMs?: number;
  now?: () => number;
  refreshLeaseDurationMs?: number;
  refreshWaitMs?: number;
  refreshers?: Partial<
    Record<ProviderCredentialKind, ProviderCredentialRefresher>
  >;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireDuration(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

export class ProviderAccessTokenService {
  readonly #accessLeaseDurationMs: number;
  readonly #inflight = new Map<
    string,
    Promise<ProviderAccountCredentialRecord>
  >();
  readonly #now: () => number;
  readonly #refreshLeaseDurationMs: number;
  readonly #refreshers: Partial<
    Record<ProviderCredentialKind, ProviderCredentialRefresher>
  >;
  readonly #refreshWaitMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly repository: ServerRepository,
    options: ProviderAccessTokenServiceOptions = {},
  ) {
    this.#accessLeaseDurationMs = requireDuration(
      options.accessLeaseDurationMs ?? DEFAULT_ACCESS_LEASE_DURATION_MS,
      "Provider access lease duration",
      30_000,
      10 * 60_000,
    );
    this.#refreshLeaseDurationMs = requireDuration(
      options.refreshLeaseDurationMs ?? DEFAULT_REFRESH_LEASE_DURATION_MS,
      "Provider refresh lease duration",
      5_000,
      2 * 60_000,
    );
    this.#refreshWaitMs = requireDuration(
      options.refreshWaitMs ?? DEFAULT_REFRESH_WAIT_MS,
      "Provider refresh wait",
      5_000,
      5 * 60_000,
    );
    this.#now = options.now ?? Date.now;
    this.#refreshers = options.refreshers ?? {};
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async issue(input: {
    accountId: string;
    forceRefresh: boolean;
    minimumValidityMs: number;
    ownerId: string;
    providerId: string;
  }): Promise<ProviderAccessTokenLease> {
    if (
      !Number.isSafeInteger(input.minimumValidityMs) ||
      input.minimumValidityMs < 30_000 ||
      input.minimumValidityMs > 10 * 60_000
    ) {
      throw new Error(
        "Provider access token validity is outside the supported range.",
      );
    }
    let record = await this.#readAvailable(input);
    if (
      input.forceRefresh ||
      !this.#isUsable(record, input.minimumValidityMs)
    ) {
      const startingRevision = record.revision;
      record = await this.#refreshSingleFlight(input, record);
      if (
        !input.forceRefresh &&
        !this.#isUsable(record, input.minimumValidityMs) &&
        record.revision !== startingRevision
      ) {
        record = await this.#refreshSingleFlight(input, record);
      }
    }
    if (!this.#isUsable(record, input.minimumValidityMs)) {
      throw new ProviderAccessTokenError("refresh-failed");
    }
    return this.#lease(record);
  }

  async #readAvailable(input: {
    accountId: string;
    ownerId: string;
    providerId: string;
  }): Promise<ProviderAccountCredentialRecord> {
    const record = await this.repository.getModelProviderAccountCredential(
      input.ownerId,
      input.providerId,
      input.accountId,
    );
    if (!record) {
      throw new ProviderAccessTokenError("credential-unavailable");
    }
    switch (record.state) {
      case "signed-in":
        return record;
      case "migration-needed":
        throw new ProviderAccessTokenError("migration-needed");
      case "reauth-required":
        throw new ProviderAccessTokenError("reauth-required");
      case "conflict":
        throw new ProviderAccessTokenError("identity-conflict");
      case "signed-out":
        throw new ProviderAccessTokenError("credential-unavailable");
    }
  }

  #isUsable(
    record: ProviderAccountCredentialRecord,
    minimumValidityMs: number,
  ): boolean {
    return (
      record.credential.expiresAt === null ||
      record.credential.expiresAt > this.#now() + minimumValidityMs
    );
  }

  #refreshSingleFlight(
    input: {
      accountId: string;
      forceRefresh: boolean;
      minimumValidityMs: number;
      ownerId: string;
      providerId: string;
    },
    record: ProviderAccountCredentialRecord,
  ): Promise<ProviderAccountCredentialRecord> {
    const key = `${input.ownerId}:${input.providerId}:${input.accountId}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const refreshing = this.#refreshAcrossInstances(input, record).finally(
      () => {
        if (this.#inflight.get(key) === refreshing) this.#inflight.delete(key);
      },
    );
    this.#inflight.set(key, refreshing);
    return refreshing;
  }

  async #refreshAcrossInstances(
    input: {
      accountId: string;
      forceRefresh: boolean;
      minimumValidityMs: number;
      ownerId: string;
      providerId: string;
    },
    initial: ProviderAccountCredentialRecord,
  ): Promise<ProviderAccountCredentialRecord> {
    const deadline = this.#now() + this.#refreshWaitMs;
    const startingRevision = initial.revision;
    let record = initial;
    while (this.#now() < deadline) {
      if (
        input.forceRefresh
          ? record.revision !== startingRevision
          : this.#isUsable(record, input.minimumValidityMs)
      ) {
        return record;
      }
      const refresher = this.#refreshers[record.credential.kind];
      if (!refresher) {
        throw new ProviderAccessTokenError("refresh-unavailable");
      }
      if (!record.credential.refreshToken) {
        await this.repository.updateModelProviderAccountCredentialState({
          accountId: input.accountId,
          expectedRevision: record.revision,
          ownerId: input.ownerId,
          providerId: input.providerId,
          state: "reauth-required",
        });
        throw new ProviderAccessTokenError("reauth-required");
      }

      const leaseId = randomUUID();
      const now = this.#now();
      const acquired =
        await this.repository.tryAcquireModelProviderAccountRefreshLease({
          accountId: input.accountId,
          expectedRevision: record.revision,
          leaseExpiresAt: new Date(now + this.#refreshLeaseDurationMs),
          leaseId,
          now: new Date(now),
          ownerId: input.ownerId,
          providerId: input.providerId,
        });
      if (acquired) {
        return this.#refreshOwned(input, record, refresher, leaseId);
      }

      await this.#sleep(REFRESH_POLL_MS);
      record = await this.#readAvailable(input);
    }
    throw new ProviderAccessTokenError("refresh-timeout");
  }

  async #refreshOwned(
    input: {
      accountId: string;
      forceRefresh: boolean;
      minimumValidityMs: number;
      ownerId: string;
      providerId: string;
    },
    record: ProviderAccountCredentialRecord,
    refresher: ProviderCredentialRefresher,
    leaseId: string,
  ): Promise<ProviderAccountCredentialRecord> {
    try {
      const refreshed = parseProviderCredential(
        await this.#refreshWithTimeout(refresher, record.credential),
        record.credential.kind,
      );
      if (
        refreshed.expiresAt !== null &&
        refreshed.expiresAt <= this.#now() + input.minimumValidityMs
      ) {
        throw new ProviderAccessTokenError("refresh-failed");
      }
      const saved = await this.repository.storeModelProviderAccountCredential(
        input.ownerId,
        input.providerId,
        input.accountId,
        refreshed,
        record.revision,
        leaseId,
      );
      if (!saved) throw new ProviderAccessTokenError("credential-unavailable");
      return saved;
    } catch (error) {
      if (error instanceof ProviderCredentialIdentityConflictError) {
        await this.repository.releaseModelProviderAccountRefreshLease({
          ...input,
          error: "Provider credential identity changed during refresh.",
          leaseId,
          state: "conflict",
        });
        throw new ProviderAccessTokenError("identity-conflict");
      }
      if (error instanceof ProviderCredentialRequiresSignInError) {
        await this.repository.releaseModelProviderAccountRefreshLease({
          ...input,
          error: "Provider credential requires sign-in.",
          leaseId,
          state: "reauth-required",
        });
        throw new ProviderAccessTokenError("reauth-required");
      }
      if (error instanceof ProviderCredentialRevisionConflictError) {
        await this.repository.releaseModelProviderAccountRefreshLease({
          ...input,
          error: "Provider credential refresh failed.",
          leaseId,
        });
        return this.#readAvailable(input);
      }
      await this.repository.releaseModelProviderAccountRefreshLease({
        ...input,
        error: "Provider credential refresh failed.",
        leaseId,
      });
      if (error instanceof ProviderAccessTokenError) throw error;
      throw new ProviderAccessTokenError("refresh-failed");
    }
  }

  async #refreshWithTimeout(
    refresher: ProviderCredentialRefresher,
    credential: ProviderCredential,
  ): Promise<ProviderCredential> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new ProviderAccessTokenError("refresh-timeout"));
      }, this.#refreshLeaseDurationMs);
      timer.unref();
    });
    try {
      return await Promise.race([
        refresher.refresh(credential, abort.signal),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }

  #lease(record: ProviderAccountCredentialRecord): ProviderAccessTokenLease {
    const issuedAt = this.#now();
    const leaseExpiresAt = Math.min(
      issuedAt + this.#accessLeaseDurationMs,
      record.credential.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (leaseExpiresAt <= issuedAt) {
      throw new ProviderAccessTokenError("refresh-failed");
    }
    const providerIdentity =
      record.credential.kind === "chatgpt"
        ? {
            accountId: record.credential.accountId,
            kind: "chatgpt" as const,
            userId: record.credential.userId,
          }
        : {
            kind: "grok" as const,
            userId: record.credential.userId,
          };
    return {
      accessToken: record.credential.accessToken,
      credentialRevision: record.revision,
      expiresAt: record.credential.expiresAt
        ? new Date(record.credential.expiresAt).toISOString()
        : null,
      issuedAt: new Date(issuedAt).toISOString(),
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      planType: record.credential.planType,
      providerAccountId: record.accountId,
      providerId: record.providerId,
      providerIdentity,
      providerKind: record.credential.kind,
    };
  }
}
