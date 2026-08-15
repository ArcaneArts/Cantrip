import { ProviderCredentialIdentityConflictError } from "../db/repository.js";
import {
  ProviderCredentialRequiresSignInError,
  type ProviderCredentialRefresher,
} from "./provider-access-tokens.js";
import type {
  ChatGptProviderCredential,
  ProviderCredential,
} from "./provider-credentials.js";

const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
const MAX_OAUTH_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const PERMANENT_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

interface ChatGptCredentialRefresherOptions {
  clientId?: string;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ChatGptRefreshResponse {
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

function authClaims(claims: Record<string, unknown>): Record<string, unknown> {
  return object(claims["https://api.openai.com/auth"]) ?? {};
}

function profileClaims(
  claims: Record<string, unknown>,
): Record<string, unknown> {
  return object(claims["https://api.openai.com/profile"]) ?? {};
}

function claimMetadata(accessToken: string, idToken: string | null) {
  const access = jwtClaims(accessToken);
  const identity = jwtClaims(idToken);
  const accessAuth = authClaims(access);
  const identityAuth = authClaims(identity);
  const identityProfile = profileClaims(identity);
  const expiry = access.exp;
  const expiresAt =
    typeof expiry === "number" &&
    Number.isSafeInteger(expiry) &&
    Number.isSafeInteger(expiry * 1_000) &&
    expiry > 0
      ? expiry * 1_000
      : null;
  return {
    accountId:
      nonemptyString(accessAuth.chatgpt_account_id) ??
      nonemptyString(identityAuth.chatgpt_account_id),
    email:
      nonemptyString(identity.email) ??
      nonemptyString(identityProfile.email) ??
      nonemptyString(access.email),
    expiresAt,
    planType:
      nonemptyString(accessAuth.chatgpt_plan_type) ??
      nonemptyString(identityAuth.chatgpt_plan_type),
    userId:
      nonemptyString(accessAuth.chatgpt_user_id) ??
      nonemptyString(accessAuth.user_id) ??
      nonemptyString(identityAuth.chatgpt_user_id) ??
      nonemptyString(identityAuth.user_id),
  };
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
    throw new Error("ChatGPT token refresh returned an oversized response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return null;
    throw new Error("ChatGPT token refresh returned malformed JSON.");
  }
}

function requireChatGptCredential(
  credential: ProviderCredential,
): ChatGptProviderCredential {
  if (credential.kind !== "chatgpt") {
    throw new Error("ChatGPT refresher received another provider kind.");
  }
  return credential;
}

/** Refreshes server-owned ChatGPT credentials without exposing refresh tokens. */
export class ChatGptCredentialRefresher implements ProviderCredentialRefresher {
  readonly #clientId: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: ChatGptCredentialRefresherOptions = {}) {
    this.#clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
    this.#endpoint = options.endpoint ?? CHATGPT_REFRESH_ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async refresh(
    input: ProviderCredential,
    signal: AbortSignal,
  ): Promise<ChatGptProviderCredential> {
    const credential = requireChatGptCredential(input);
    if (!credential.refreshToken) {
      throw new ProviderCredentialRequiresSignInError();
    }
    const response = await this.#fetch(this.#endpoint, {
      body: JSON.stringify({
        client_id: this.#clientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      headers: { "content-type": "application/json" },
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
      throw new Error("ChatGPT token refresh failed.");
    }

    const tokens = object(payload) as ChatGptRefreshResponse | null;
    const accessToken = nonemptyString(tokens?.access_token);
    if (!accessToken) {
      throw new Error("ChatGPT token refresh returned no access token.");
    }
    const returnedIdToken = nonemptyString(tokens?.id_token);
    const metadata = claimMetadata(accessToken, returnedIdToken);
    if (
      (metadata.accountId && metadata.accountId !== credential.accountId) ||
      (metadata.userId &&
        credential.userId &&
        metadata.userId !== credential.userId)
    ) {
      throw new ProviderCredentialIdentityConflictError();
    }
    const expiresIn = tokens?.expires_in;
    const observedAt = this.#now();
    const expiresAt =
      metadata.expiresAt ??
      (typeof expiresIn === "number" &&
      Number.isSafeInteger(expiresIn) &&
      expiresIn > 0 &&
      Number.isSafeInteger(observedAt + expiresIn * 1_000)
        ? observedAt + expiresIn * 1_000
        : null);
    return {
      accessToken,
      accountId: credential.accountId,
      email: metadata.email ?? credential.email,
      expiresAt,
      idToken: returnedIdToken ?? credential.idToken,
      kind: "chatgpt",
      planType: metadata.planType ?? credential.planType,
      refreshToken:
        nonemptyString(tokens?.refresh_token) ?? credential.refreshToken,
      userId: metadata.userId ?? credential.userId,
      version: 1,
    };
  }
}
