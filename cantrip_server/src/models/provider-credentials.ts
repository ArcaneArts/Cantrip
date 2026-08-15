export type ProviderCredentialKind = "chatgpt" | "grok";

interface ProviderCredentialBase {
  accessToken: string;
  email: string | null;
  expiresAt: number | null;
  planType: string | null;
  refreshToken: string | null;
  version: 1;
}

export interface ChatGptProviderCredential extends ProviderCredentialBase {
  accountId: string;
  idToken: string | null;
  kind: "chatgpt";
  userId: string | null;
}

export interface GrokProviderCredential extends ProviderCredentialBase {
  kind: "grok";
  userId: string;
}

export type ProviderCredential =
  ChatGptProviderCredential | GrokProviderCredential;

export interface RedactedProviderCredential {
  email: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  kind: ProviderCredentialKind;
  planType: string | null;
  subject: string;
  version: 1;
}

const MAX_TOKEN_LENGTH = 1_000_000;
const MAX_IDENTITY_LENGTH = 512;
const MAX_METADATA_LENGTH = 1_024;

function credentialError(field?: string): Error {
  return new Error(
    field
      ? `Stored provider credential has an invalid ${field}.`
      : "Stored provider credential is malformed.",
  );
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw credentialError();
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > maximumLength
  ) {
    throw credentialError(field);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | null {
  const candidate = value[field];
  if (candidate === null) return null;
  if (
    typeof candidate !== "string" ||
    candidate.length < 1 ||
    candidate.length > maximumLength
  ) {
    throw credentialError(field);
  }
  return candidate;
}

function expiresAt(value: Record<string, unknown>): number | null {
  const candidate = value.expiresAt;
  if (candidate === null) return null;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0
  ) {
    throw credentialError("expiry");
  }
  return candidate;
}

/**
 * Parses the server's encrypted credential payload without ever echoing token
 * values in validation errors. This type is deliberately server-internal and
 * must not be added to public API response schemas.
 */
export function parseProviderCredential(
  input: string | unknown,
  expectedKind?: ProviderCredentialKind,
): ProviderCredential {
  let parsed: unknown;
  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw credentialError();
  }
  const value = parseObject(parsed);
  if (value.version !== 1) throw credentialError("version");
  if (value.kind !== "chatgpt" && value.kind !== "grok") {
    throw credentialError("provider kind");
  }
  if (expectedKind && value.kind !== expectedKind) {
    throw credentialError("provider kind");
  }

  const common = {
    accessToken: requiredString(value, "accessToken", MAX_TOKEN_LENGTH),
    email: optionalString(value, "email", MAX_METADATA_LENGTH),
    expiresAt: expiresAt(value),
    planType: optionalString(value, "planType", MAX_METADATA_LENGTH),
    refreshToken: optionalString(value, "refreshToken", MAX_TOKEN_LENGTH),
    version: 1 as const,
  };
  if (value.kind === "chatgpt") {
    return {
      ...common,
      accountId: requiredString(value, "accountId", MAX_IDENTITY_LENGTH),
      idToken: optionalString(value, "idToken", MAX_TOKEN_LENGTH),
      kind: "chatgpt",
      userId: optionalString(value, "userId", MAX_IDENTITY_LENGTH),
    };
  }
  return {
    ...common,
    kind: "grok",
    userId: requiredString(value, "userId", MAX_IDENTITY_LENGTH),
  };
}

export function serializeProviderCredential(
  credential: ProviderCredential,
): string {
  return JSON.stringify(parseProviderCredential(credential, credential.kind));
}

export function providerCredentialSubject(
  credential: ProviderCredential,
): string {
  return credential.kind === "chatgpt"
    ? `chatgpt:${credential.accountId}`
    : `grok:${credential.userId}`;
}

/** Safe for API responses and structured logs. */
export function redactProviderCredential(
  credential: ProviderCredential,
): RedactedProviderCredential {
  return {
    email: credential.email,
    expiresAt: credential.expiresAt,
    hasRefreshToken: credential.refreshToken !== null,
    kind: credential.kind,
    planType: credential.planType,
    subject: providerCredentialSubject(credential),
    version: credential.version,
  };
}
