import type { ProviderLegacyCredential } from "@cantrip/protocol";

const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ENDPOINT = "https://auth.openai.com/oauth/token";
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_ENDPOINT = "https://auth.x.ai/oauth2/token";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export class ProviderCredentialRequiresSignInError extends Error {}
export class ProviderCredentialIdentityConflictError extends Error {}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function claims(token: string | null): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    return (
      object(JSON.parse(Buffer.from(payload, "base64url").toString())) ?? {}
    );
  } catch {
    return {};
  }
}

function expiry(token: string): number | null {
  const value = claims(token).exp;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value * 1_000
    : null;
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("Provider token refresh returned an oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Provider token refresh returned malformed JSON.");
  }
  const parsed = object(decoded);
  if (!parsed)
    throw new Error("Provider token refresh returned malformed JSON.");
  if (!response.ok) {
    const code = string(parsed.error)?.toLowerCase();
    if (response.status === 401 || code === "invalid_grant") {
      throw new ProviderCredentialRequiresSignInError();
    }
    throw new Error("Provider token refresh failed.");
  }
  return parsed;
}

function authClaims(token: string | null) {
  return object(claims(token)["https://api.openai.com/auth"]) ?? {};
}

export async function refreshProviderCredential(
  credential: ProviderLegacyCredential,
  signal: AbortSignal,
): Promise<ProviderLegacyCredential> {
  if (!credential.refreshToken) {
    throw new ProviderCredentialRequiresSignInError();
  }
  if (credential.kind === "chatgpt") {
    const response = await fetch(CHATGPT_ENDPOINT, {
      body: JSON.stringify({
        client_id: CHATGPT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
    const payload = await responseJson(response);
    const accessToken = string(payload.access_token);
    if (!accessToken)
      throw new Error("ChatGPT refresh returned no access token.");
    const idToken = string(payload.id_token) ?? credential.idToken;
    const auth = authClaims(accessToken);
    const idAuth = authClaims(idToken);
    const accountId =
      string(auth.chatgpt_account_id) ?? string(idAuth.chatgpt_account_id);
    const userId =
      string(auth.chatgpt_user_id) ?? string(idAuth.chatgpt_user_id);
    if (
      (accountId && accountId !== credential.accountId) ||
      (userId && credential.userId && userId !== credential.userId)
    ) {
      throw new ProviderCredentialIdentityConflictError();
    }
    const expiresIn = payload.expires_in;
    return {
      ...credential,
      accessToken,
      expiresAt:
        expiry(accessToken) ??
        (typeof expiresIn === "number" && expiresIn > 0
          ? Date.now() + expiresIn * 1_000
          : null),
      idToken,
      refreshToken: string(payload.refresh_token) ?? credential.refreshToken,
      userId: userId ?? credential.userId,
    };
  }

  const response = await fetch(GROK_ENDPOINT, {
    body: new URLSearchParams({
      client_id: GROK_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal,
  });
  const payload = await responseJson(response);
  const accessToken = string(payload.access_token);
  if (!accessToken) throw new Error("Grok refresh returned no access token.");
  const identity = claims(string(payload.id_token));
  const userId = string(identity.sub);
  if (userId && userId !== credential.userId) {
    throw new ProviderCredentialIdentityConflictError();
  }
  const expiresIn = payload.expires_in;
  return {
    ...credential,
    accessToken,
    email: string(identity.email) ?? credential.email,
    expiresAt:
      expiry(accessToken) ??
      (typeof expiresIn === "number" && expiresIn > 0
        ? Date.now() + expiresIn * 1_000
        : credential.expiresAt),
    refreshToken: string(payload.refresh_token) ?? credential.refreshToken,
    userId: userId ?? credential.userId,
  };
}
