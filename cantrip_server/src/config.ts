import path from "node:path";

import {
  authModeSchema,
  bootstrapModeSchema,
  deploymentModeSchema,
  type AuthMode,
  type BootstrapMode,
  type DeploymentMode,
} from "@cantrip/protocol";

const DEFAULT_WORKER_TOKEN = "cantrip-local-development";

function readPort(
  value: string | undefined,
  name = "CANTRIP_SERVER_PORT",
  fallback = 4_310,
): number {
  const port = Number.parseInt(value ?? String(fallback), 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return port;
}

export interface ServerConfig {
  adminBootstrapToken?: string;
  allowInsecureRemote: boolean;
  appOrigins: string[];
  authRateLimit?: number;
  authMode: AuthMode;
  bootstrapMode: BootstrapMode;
  dataDirectory: string;
  databaseUrl?: string;
  deploymentMode: DeploymentMode;
  agentModel: string;
  agentModelProvider: string;
  ollamaBaseUrl: string;
  host: string;
  cookieSameSite?: "lax" | "none" | "strict";
  cookieSecure?: boolean;
  passwordHash?: string;
  port: number;
  publicRegistration?: boolean;
  sessionTtlSeconds?: number;
  codeSurfaceHost?: string;
  codeSurfaceOrigin?: string;
  codeSurfacePort?: number;
  workerToken: string;
  remoteSurfaceWebRtc?: RemoteSurfaceTurnConfig;
  secretEncryption?: SecretEncryptionConfig;
}

export interface SecretEncryptionKeyConfig {
  id: string;
  key: Uint8Array;
}

export interface SecretEncryptionConfig {
  activeKeyId: string;
  keys: SecretEncryptionKeyConfig[];
}

function readBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error(`Invalid ${name}: expected true, false, 1, or 0.`);
}

export interface RemoteSurfaceTurnConfig {
  negotiationTimeoutMs: number;
  sharedSecret: string;
  ttlSeconds: number;
  urls: string[];
}

export interface CodeSurfaceConfig {
  host: string;
  origin: string;
  port: number;
}

export function resolveCodeSurfaceConfig(
  config: ServerConfig,
): CodeSurfaceConfig {
  const port = config.codeSurfacePort ?? config.port + 1;
  if (port > 65_535) {
    throw new Error(
      "CANTRIP_CODE_SURFACE_PORT is required when CANTRIP_SERVER_PORT is 65535.",
    );
  }
  const host = config.codeSurfaceHost ?? config.host;
  const origin = new URL(
    config.codeSurfaceOrigin ??
      `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  );
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      "CANTRIP_CODE_SURFACE_ORIGIN must be an HTTP(S) origin without a path or credentials.",
    );
  }
  return { host, origin: origin.origin, port };
}

function readBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function readRemoteSurfaceWebRtcConfig(): RemoteSurfaceTurnConfig | undefined {
  const urls = (process.env.CANTRIP_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const sharedSecret = process.env.CANTRIP_TURN_SHARED_SECRET?.trim();
  if (urls.length === 0 && !sharedSecret) return undefined;
  if (urls.length === 0 || !sharedSecret) {
    throw new Error(
      "CANTRIP_TURN_URLS and CANTRIP_TURN_SHARED_SECRET must be configured together.",
    );
  }
  if (
    urls.some((url) => !url.startsWith("turn:") && !url.startsWith("turns:"))
  ) {
    throw new Error("CANTRIP_TURN_URLS only accepts turn: or turns: URLs.");
  }
  return {
    urls,
    sharedSecret,
    ttlSeconds: readBoundedInteger(
      "CANTRIP_TURN_TTL_SECONDS",
      process.env.CANTRIP_TURN_TTL_SECONDS,
      600,
      60,
      3_600,
    ),
    negotiationTimeoutMs: readBoundedInteger(
      "CANTRIP_WEBRTC_NEGOTIATION_TIMEOUT_MS",
      process.env.CANTRIP_WEBRTC_NEGOTIATION_TIMEOUT_MS,
      8_000,
      1_000,
      30_000,
    ),
  };
}

function decodeSecretEncryptionKey(id: string, value: unknown): Uint8Array {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(id)) {
    throw new Error(
      "CANTRIP_SECRET_ENCRYPTION_KEYS contains an invalid key identifier.",
    );
  }
  if (typeof value !== "string") {
    throw new Error(
      `CANTRIP_SECRET_ENCRYPTION_KEYS entry ${id} must be a base64 string.`,
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== value) {
    throw new Error(
      `CANTRIP_SECRET_ENCRYPTION_KEYS entry ${id} must encode exactly 32 bytes using canonical base64.`,
    );
  }
  return key;
}

function readSecretEncryptionConfig(): SecretEncryptionConfig | undefined {
  const encoded = process.env.CANTRIP_SECRET_ENCRYPTION_KEYS?.trim();
  if (!encoded) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error(
      "CANTRIP_SECRET_ENCRYPTION_KEYS must be a JSON object of key IDs to base64-encoded 32-byte keys.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "CANTRIP_SECRET_ENCRYPTION_KEYS must be a JSON object of key IDs to base64-encoded 32-byte keys.",
    );
  }
  const keys = Object.entries(parsed).map(([id, value]) => ({
    id,
    key: decodeSecretEncryptionKey(id, value),
  }));
  if (keys.length === 0 || keys.length > 16) {
    throw new Error(
      "CANTRIP_SECRET_ENCRYPTION_KEYS must contain between 1 and 16 keys.",
    );
  }
  const activeKeyId =
    process.env.CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID?.trim() ??
    (keys.length === 1 ? keys[0]!.id : "");
  if (!keys.some(({ id }) => id === activeKeyId)) {
    throw new Error(
      "CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID must name a configured encryption key.",
    );
  }
  return { activeKeyId, keys };
}

export function readServerConfig(): ServerConfig {
  const host = process.env.CANTRIP_SERVER_HOST ?? "127.0.0.1";
  const workerToken = process.env.CANTRIP_WORKER_TOKEN ?? DEFAULT_WORKER_TOKEN;
  const deploymentMode = deploymentModeSchema.parse(
    process.env.CANTRIP_DEPLOYMENT_MODE ?? "local",
  );
  const bootstrapMode = bootstrapModeSchema.parse(
    process.env.CANTRIP_BOOTSTRAP_MODE ?? "pnpm-dev",
  );
  const authMode = authModeSchema.parse(
    process.env.CANTRIP_AUTH_MODE ?? "none",
  );
  const secretEncryption = readSecretEncryptionConfig();
  const allowInsecureRemote = readBoolean(
    "CANTRIP_ALLOW_INSECURE_REMOTE",
    process.env.CANTRIP_ALLOW_INSECURE_REMOTE,
  );
  const passwordHash = process.env.CANTRIP_PASSWORD_HASH?.trim();
  if (authMode === "password" && !passwordHash?.startsWith("$argon2id$")) {
    throw new Error(
      "CANTRIP_AUTH_MODE=password requires CANTRIP_PASSWORD_HASH to contain an Argon2id encoded hash.",
    );
  }
  const adminBootstrapToken = process.env.CANTRIP_ADMIN_BOOTSTRAP_TOKEN?.trim();
  if (adminBootstrapToken && adminBootstrapToken.length < 32) {
    throw new Error(
      "CANTRIP_ADMIN_BOOTSTRAP_TOKEN must contain at least 32 characters.",
    );
  }
  const cookieSameSiteInput = process.env.CANTRIP_COOKIE_SAME_SITE;
  if (
    cookieSameSiteInput !== undefined &&
    !["lax", "none", "strict"].includes(cookieSameSiteInput)
  ) {
    throw new Error(
      "Invalid CANTRIP_COOKIE_SAME_SITE: expected lax, none, or strict.",
    );
  }

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (
    authMode === "none" &&
    (!loopback || deploymentMode === "hosted") &&
    !allowInsecureRemote
  ) {
    throw new Error(
      "Unauthenticated remote access is disabled. Set CANTRIP_ALLOW_INSECURE_REMOTE=true only behind a trusted network or authenticating reverse proxy.",
    );
  }
  const developmentWorkerBootstrap =
    deploymentMode === "local" &&
    authMode === "none" &&
    loopback &&
    ["pnpm-dev", "tauri"].includes(bootstrapMode);
  if (
    process.env.CANTRIP_WORKER_TOKEN !== undefined &&
    !developmentWorkerBootstrap
  ) {
    throw new Error(
      "CANTRIP_WORKER_TOKEN is restricted to anonymous loopback pnpm-dev and Tauri bootstraps. Enroll standalone and hosted workers with a one-time link code.",
    );
  }
  if (deploymentMode === "hosted" && !secretEncryption) {
    throw new Error(
      "Hosted deployments require CANTRIP_SECRET_ENCRYPTION_KEYS so provider secrets can be encrypted at rest.",
    );
  }

  const port = readPort(process.env.CANTRIP_SERVER_PORT);
  const codeSurfacePort = readPort(
    process.env.CANTRIP_CODE_SURFACE_PORT,
    "CANTRIP_CODE_SURFACE_PORT",
    port < 65_535 ? port + 1 : 0,
  );
  const codeSurfaceHost = process.env.CANTRIP_CODE_SURFACE_HOST ?? host;
  const codeSurfaceOrigin =
    process.env.CANTRIP_CODE_SURFACE_ORIGIN ??
    `http://${codeSurfaceHost.includes(":") ? `[${codeSurfaceHost}]` : codeSurfaceHost}:${codeSurfacePort}`;

  const config: ServerConfig = {
    adminBootstrapToken,
    allowInsecureRemote,
    appOrigins: (
      process.env.CANTRIP_APP_ORIGINS ??
      process.env.CANTRIP_APP_ORIGIN ??
      "http://127.0.0.1:5173,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost,capacitor://localhost"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    authMode,
    authRateLimit: readBoundedInteger(
      "CANTRIP_AUTH_RATE_LIMIT",
      process.env.CANTRIP_AUTH_RATE_LIMIT,
      10,
      1,
      1_000,
    ),
    bootstrapMode,
    dataDirectory: path.resolve(
      process.cwd(),
      process.env.CANTRIP_DATA_DIR ?? "../.cantrip/dev",
    ),
    databaseUrl: process.env.DATABASE_URL,
    deploymentMode,
    agentModel: process.env.CANTRIP_AGENT_MODEL ?? "gemma4:26b",
    agentModelProvider: process.env.CANTRIP_AGENT_MODEL_PROVIDER ?? "ollama",
    ollamaBaseUrl:
      process.env.CANTRIP_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    host,
    cookieSameSite:
      cookieSameSiteInput === "strict"
        ? "strict"
        : cookieSameSiteInput === "none"
          ? "none"
          : deploymentMode === "hosted"
            ? "none"
            : "lax",
    cookieSecure:
      process.env.CANTRIP_COOKIE_SECURE === undefined
        ? deploymentMode === "hosted"
        : readBoolean(
            "CANTRIP_COOKIE_SECURE",
            process.env.CANTRIP_COOKIE_SECURE,
          ),
    passwordHash,
    port,
    publicRegistration: readBoolean(
      "CANTRIP_PUBLIC_REGISTRATION",
      process.env.CANTRIP_PUBLIC_REGISTRATION,
    ),
    sessionTtlSeconds: readBoundedInteger(
      "CANTRIP_SESSION_TTL_SECONDS",
      process.env.CANTRIP_SESSION_TTL_SECONDS,
      30 * 24 * 60 * 60,
      300,
      365 * 24 * 60 * 60,
    ),
    codeSurfaceHost,
    codeSurfaceOrigin,
    codeSurfacePort,
    workerToken,
    remoteSurfaceWebRtc: readRemoteSurfaceWebRtcConfig(),
    secretEncryption,
  };
  if (config.cookieSameSite === "none" && !config.cookieSecure) {
    throw new Error(
      "CANTRIP_COOKIE_SAME_SITE=none requires CANTRIP_COOKIE_SECURE=true.",
    );
  }
  resolveCodeSurfaceConfig(config);
  return config;
}
