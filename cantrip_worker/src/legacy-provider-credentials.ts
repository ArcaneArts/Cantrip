import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import {
  providerLegacyCredentialSchema,
  type ProviderLegacyCredential,
} from "@cantrip/protocol";

const MAX_CREDENTIAL_FILE_BYTES = 4 * 1_024 * 1_024;

function credentialPath(
  credentialHome: string,
  kind: "chatgpt" | "grok",
): string {
  return path.join(
    credentialHome,
    kind === "chatgpt" ? "auth.json" : "grok-auth.json",
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jwtClaims(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const payload = value.split(".")[1];
  if (!payload) return {};
  try {
    return (
      object(JSON.parse(Buffer.from(payload, "base64url").toString())) ?? {}
    );
  } catch {
    return {};
  }
}

function jwtExpiry(value: string): number | null {
  const expiry = jwtClaims(value).exp;
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

function chatGptCredential(value: Record<string, unknown>): unknown {
  const tokens = object(value.tokens);
  if (!tokens) return null;
  const accessToken = nullableString(tokens.access_token);
  const idToken = nullableString(tokens.id_token);
  if (!accessToken) return null;
  const claims = jwtClaims(idToken);
  const auth = object(claims["https://api.openai.com/auth"]);
  const profile = object(claims["https://api.openai.com/profile"]);
  const accountId =
    nullableString(tokens.account_id) ??
    nullableString(auth?.chatgpt_account_id);
  if (!accountId) return null;
  return {
    accessToken,
    accountId,
    email: nullableString(claims.email) ?? nullableString(profile?.email),
    expiresAt: jwtExpiry(accessToken),
    idToken,
    kind: "chatgpt",
    planType: nullableString(auth?.chatgpt_plan_type),
    refreshToken: nullableString(tokens.refresh_token),
    userId:
      nullableString(auth?.chatgpt_user_id) ?? nullableString(auth?.user_id),
    version: 1,
  };
}

function grokCredential(value: Record<string, unknown>): unknown {
  return {
    accessToken: value.accessToken,
    email: nullableString(value.email),
    expiresAt: value.expiresAt ?? null,
    kind: "grok",
    planType: nullableString(value.planType),
    refreshToken: nullableString(value.refreshToken),
    userId: value.userId,
    version: value.version,
  };
}

async function readCredentialFile(file: string): Promise<unknown | null> {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error(
      "Legacy provider credential file is not a bounded regular file.",
    );
  }
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export function legacyProviderCredentialSubject(
  credential: ProviderLegacyCredential,
): string {
  return credential.kind === "chatgpt"
    ? `chatgpt:${credential.accountId}`
    : `grok:${credential.userId}`;
}

export type LocalProviderCredentialCaptureResult =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "available"; credential: ProviderLegacyCredential };

export async function captureLegacyProviderCredential(
  credentialHome: string,
  kind: "chatgpt" | "grok",
): Promise<LocalProviderCredentialCaptureResult> {
  let parsed: unknown | null;
  try {
    parsed = await readCredentialFile(credentialPath(credentialHome, kind));
  } catch {
    return { status: "malformed" };
  }
  if (parsed === null) return { status: "missing" };
  const value = object(parsed);
  if (!value) return { status: "malformed" };
  const credential = providerLegacyCredentialSchema.safeParse(
    kind === "chatgpt" ? chatGptCredential(value) : grokCredential(value),
  );
  return credential.success
    ? { status: "available", credential: credential.data }
    : { status: "malformed" };
}

/**
 * Removes any worker-local credential for an account after the server has
 * made sign-out authoritative. Unlike provider logout, this never contacts
 * the upstream provider and therefore cannot race revocation across workers.
 */
export async function discardLegacyProviderCredential(
  credentialHome: string,
  kind: "chatgpt" | "grok",
): Promise<boolean> {
  try {
    await unlink(credentialPath(credentialHome, kind));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
