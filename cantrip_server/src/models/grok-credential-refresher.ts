import { ProviderCredentialIdentityConflictError } from "../db/repository.js";
import {
  ProviderCredentialRequiresSignInError,
  type ProviderCredentialRefresher,
} from "./provider-access-tokens.js";
import type {
  GrokProviderCredential,
  ProviderCredential,
} from "./provider-credentials.js";

const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_REFRESH_ENDPOINT = "https://auth.x.ai/oauth2/token";
const MAX_OAUTH_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const PERMANENT_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

interface GrokCredentialRefresherOptions {
  clientId?: string;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface GrokRefreshResponse {
  access_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jwtClaims(token: string | null): Record<string, unknown> {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return (
      object(JSON.parse(Buffer.from(payload, "base64url").toString())) ?? {}
    );
  } catch {
    return {};
  }
}

function jwtExpiry(token: string): number | null {
  const expiry = jwtClaims(token).exp;
  if (
    typeof expiry !== "number" ||
    !Number.isSafeInteger(expiry) ||
    expiry <= 0
  ) {
    return null;
  }
  const milliseconds = expiry * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function refreshFailureCode(payload: unknown): string | null {
  const value = object(payload);
  const error = value?.error;
  if (typeof error === "string") return error.toLowerCase();
  const details = object(error);
  return (
    nonemptyString(details?.code)?.toLowerCase() ??
    nonemptyString(details?.type)?.toLowerCase() ??
    nonemptyString(value?.code)?.toLowerCase() ??
    null
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_OAUTH_RESPONSE_BYTES) {
    throw new Error("Grok token refresh returned an oversized response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return null;
    throw new Error("Grok token refresh returned malformed JSON.");
  }
}

function requireGrokCredential(
  credential: ProviderCredential,
): GrokProviderCredential {
  if (credential.kind !== "grok") {
    throw new Error("Grok refresher received another provider kind.");
  }
  return credential;
}

/** Refreshes server-owned Grok credentials without exposing refresh tokens. */
export class GrokCredentialRefresher implements ProviderCredentialRefresher {
  readonly #clientId: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GrokCredentialRefresherOptions = {}) {
    this.#clientId = options.clientId ?? GROK_OAUTH_CLIENT_ID;
    this.#endpoint = options.endpoint ?? GROK_REFRESH_ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async refresh(
    input: ProviderCredential,
    signal: AbortSignal,
  ): Promise<GrokProviderCredential> {
    const credential = requireGrokCredential(input);
    if (!credential.refreshToken) {
      throw new ProviderCredentialRequiresSignInError();
    }
    const response = await this.#fetch(this.#endpoint, {
      body: new URLSearchParams({
        client_id: this.#clientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal,
    });
    const payload = await boundedJson(response);
    if (!response.ok) {
      const code = refreshFailureCode(payload);
      if (
        response.status === 401 ||
        (code && PERMANENT_REFRESH_CODES.has(code))
      ) {
        throw new ProviderCredentialRequiresSignInError();
      }
      throw new Error("Grok token refresh failed.");
    }

    const tokens = object(payload) as GrokRefreshResponse | null;
    const accessToken = nonemptyString(tokens?.access_token);
    if (!accessToken) {
      throw new Error("Grok token refresh returned no access token.");
    }
    const idClaims = jwtClaims(nonemptyString(tokens?.id_token));
    const returnedUserId = nonemptyString(idClaims.sub);
    if (returnedUserId && returnedUserId !== credential.userId) {
      throw new ProviderCredentialIdentityConflictError();
    }
    const expiresIn = tokens?.expires_in;
    const observedAt = this.#now();
    const expiresAt =
      jwtExpiry(accessToken) ??
      (typeof expiresIn === "number" &&
      Number.isSafeInteger(expiresIn) &&
      expiresIn > 0 &&
      Number.isSafeInteger(observedAt + expiresIn * 1_000)
        ? observedAt + expiresIn * 1_000
        : credential.expiresAt);
    return {
      accessToken,
      email: nonemptyString(idClaims.email) ?? credential.email,
      expiresAt,
      kind: "grok",
      planType: credential.planType,
      refreshToken:
        nonemptyString(tokens?.refresh_token) ?? credential.refreshToken,
      userId: returnedUserId ?? credential.userId,
      version: 1,
    };
  }
}
