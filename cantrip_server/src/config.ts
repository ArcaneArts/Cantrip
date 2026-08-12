import path from "node:path";
import { isIP } from "node:net";

import {
  authModeSchema,
  bootstrapModeSchema,
  deploymentModeSchema,
  type AuthMode,
  type BootstrapMode,
  type DeploymentMode,
} from "@cantrip/protocol";

const DEFAULT_WORKER_TOKEN = "cantrip-local-development";
const DEFAULT_APP_ORIGINS =
  "http://127.0.0.1:5173,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost,capacitor://localhost";
const TRUST_PROXY_ALIASES = new Set(["linklocal", "loopback", "uniquelocal"]);

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
  apiBodyLimitBytes?: number;
  apiRateLimitPerMinute?: number;
  accountCommandConcurrency?: number;
  accountCommandRatePerMinute?: number;
  accountRelayBytesPerMinute?: number;
  accountRemoteSurfaceLimit?: number;
  accountUploadBytesPerMinute?: number;
  accountUploadConcurrency?: number;
  accountWebsocketLimit?: number;
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
  metricsToken?: string;
  cookieSameSite?: "lax" | "none" | "strict";
  cookieSecure?: boolean;
  passwordHash?: string;
  pairingRateLimitPerMinute?: number;
  port: number;
  publicOrigin?: string;
  publicRegistration?: boolean;
  redisUrl?: string;
  requireHttps?: boolean;
  sessionTtlSeconds?: number;
  codeSurfaceHost?: string;
  codeSurfaceOrigin?: string;
  codeSurfacePort?: number;
  coordinationMaxInstances?: number;
  coordinationPresenceTtlMs?: number;
  workerToken: string;
  remoteSurfaceWebRtc?: RemoteSurfaceTurnConfig;
  secretEncryption?: SecretEncryptionConfig;
  serverInstanceId?: string;
  trustedProxies?: string[];
  uploadLimitBytes?: number;
  uploadRateLimitPerMinute?: number;
  websocketHandshakeRatePerMinute?: number;
  websocketMaxPayloadBytes?: number;
  workerCommandConcurrency?: number;
  workerCommandRatePerMinute?: number;
  workerRelayBytesPerMinute?: number;
  workerRemoteSurfaceLimit?: number;
  workerUploadBytesPerMinute?: number;
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

function normalizeHttpOrigin(
  name: string,
  value: string,
  requireHttps: boolean,
): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin.`);
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      `${name} must be an HTTP(S) origin without a path, wildcard, or credentials.`,
    );
  }
  if (requireHttps && origin.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in hosted mode.`);
  }
  return origin.origin;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function readAppOrigins(deploymentMode: DeploymentMode): string[] {
  const configured =
    process.env.CANTRIP_APP_ORIGINS ?? process.env.CANTRIP_APP_ORIGIN;
  if (deploymentMode === "hosted" && !configured?.trim()) {
    throw new Error("Hosted deployments require explicit CANTRIP_APP_ORIGINS.");
  }
  const values = (configured ?? DEFAULT_APP_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > 32) {
    throw new Error(
      "CANTRIP_APP_ORIGINS must contain between 1 and 32 origins.",
    );
  }
  const origins = values.map((value) => {
    if (value.includes("*")) {
      throw new Error("CANTRIP_APP_ORIGINS does not allow wildcard origins.");
    }
    if (/^(?:tauri|capacitor):\/\/localhost$/u.test(value)) return value;
    const normalized = normalizeHttpOrigin("CANTRIP_APP_ORIGINS", value, false);
    const parsed = new URL(normalized);
    if (
      deploymentMode === "hosted" &&
      parsed.protocol !== "https:" &&
      !loopbackHostname(parsed.hostname)
    ) {
      throw new Error(
        "Hosted CANTRIP_APP_ORIGINS entries must use HTTPS unless they are loopback origins.",
      );
    }
    return normalized;
  });
  return [...new Set(origins)];
}

function validProxyAddress(value: string): boolean {
  if (TRUST_PROXY_ALIASES.has(value)) return true;
  const separator = value.lastIndexOf("/");
  const address = separator < 0 ? value : value.slice(0, separator);
  const family = isIP(address);
  if (!family) return false;
  if (separator < 0) return true;
  const prefix = Number(value.slice(separator + 1));
  return (
    Number.isInteger(prefix) &&
    prefix >= 0 &&
    prefix <= (family === 4 ? 32 : 128)
  );
}

function readTrustedProxies(deploymentMode: DeploymentMode): string[] {
  const proxies = (process.env.CANTRIP_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    proxies.length > 32 ||
    proxies.some((value) => !validProxyAddress(value))
  ) {
    throw new Error(
      "CANTRIP_TRUSTED_PROXIES accepts at most 32 IP addresses, CIDR ranges, or loopback/linklocal/uniquelocal aliases.",
    );
  }
  if (deploymentMode === "hosted" && proxies.length === 0) {
    throw new Error(
      "Hosted deployments require explicit CANTRIP_TRUSTED_PROXIES.",
    );
  }
  return [...new Set(proxies)];
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
  const metricsToken = process.env.CANTRIP_METRICS_TOKEN?.trim();
  if (metricsToken && metricsToken.length < 32) {
    throw new Error(
      "CANTRIP_METRICS_TOKEN must contain at least 32 characters.",
    );
  }
  const serverInstanceId =
    process.env.CANTRIP_SERVER_INSTANCE_ID?.trim() || undefined;
  if (
    serverInstanceId &&
    (serverInstanceId.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(serverInstanceId))
  ) {
    throw new Error("CANTRIP_SERVER_INSTANCE_ID is invalid.");
  }
  const redisUrl = process.env.REDIS_URL?.trim() || undefined;
  if (redisUrl) {
    let parsedRedisUrl: URL;
    try {
      parsedRedisUrl = new URL(redisUrl);
    } catch {
      throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL.");
    }
    if (!["redis:", "rediss:"].includes(parsedRedisUrl.protocol)) {
      throw new Error("REDIS_URL must use redis:// or rediss://.");
    }
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
  if (deploymentMode === "hosted" && authMode === "none") {
    throw new Error(
      "Hosted deployments require CANTRIP_AUTH_MODE=accounts or password; CANTRIP_ALLOW_INSECURE_REMOTE cannot enable anonymous hosted access.",
    );
  }
  if (deploymentMode === "hosted" && bootstrapMode !== "hosted") {
    throw new Error(
      "Hosted deployments require CANTRIP_BOOTSTRAP_MODE=hosted so bootstrap capabilities describe the deployment truthfully.",
    );
  }
  if (deploymentMode === "hosted" && allowInsecureRemote) {
    throw new Error(
      "CANTRIP_ALLOW_INSECURE_REMOTE is not permitted in hosted mode.",
    );
  }
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
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  if (deploymentMode === "hosted" && !databaseUrl) {
    throw new Error("Hosted deployments require DATABASE_URL for PostgreSQL.");
  }
  const appOrigins = readAppOrigins(deploymentMode);
  const trustedProxies = readTrustedProxies(deploymentMode);

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
  const publicOriginInput = process.env.CANTRIP_PUBLIC_ORIGIN?.trim();
  if (deploymentMode === "hosted" && !publicOriginInput) {
    throw new Error("Hosted deployments require CANTRIP_PUBLIC_ORIGIN.");
  }
  const publicOrigin = publicOriginInput
    ? normalizeHttpOrigin(
        "CANTRIP_PUBLIC_ORIGIN",
        publicOriginInput,
        deploymentMode === "hosted",
      )
    : undefined;
  const normalizedCodeSurfaceOrigin = normalizeHttpOrigin(
    "CANTRIP_CODE_SURFACE_ORIGIN",
    codeSurfaceOrigin,
    deploymentMode === "hosted",
  );
  if (publicOrigin && normalizedCodeSurfaceOrigin === publicOrigin) {
    throw new Error(
      "CANTRIP_CODE_SURFACE_ORIGIN must be isolated from CANTRIP_PUBLIC_ORIGIN.",
    );
  }

  const config: ServerConfig = {
    adminBootstrapToken,
    allowInsecureRemote,
    apiBodyLimitBytes: readBoundedInteger(
      "CANTRIP_API_BODY_LIMIT_BYTES",
      process.env.CANTRIP_API_BODY_LIMIT_BYTES,
      1_024 * 1_024,
      16 * 1_024,
      16 * 1_024 * 1_024,
    ),
    apiRateLimitPerMinute: readBoundedInteger(
      "CANTRIP_API_RATE_LIMIT_PER_MINUTE",
      process.env.CANTRIP_API_RATE_LIMIT_PER_MINUTE,
      1_200,
      60,
      100_000,
    ),
    accountCommandConcurrency: readBoundedInteger(
      "CANTRIP_ACCOUNT_COMMAND_CONCURRENCY",
      process.env.CANTRIP_ACCOUNT_COMMAND_CONCURRENCY,
      128,
      1,
      10_000,
    ),
    accountCommandRatePerMinute: readBoundedInteger(
      "CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE",
      process.env.CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE,
      2_400,
      60,
      100_000,
    ),
    accountRelayBytesPerMinute: readBoundedInteger(
      "CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE",
      process.env.CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE,
      512 * 1_024 * 1_024,
      1 * 1_024 * 1_024,
      64 * 1_024 * 1_024 * 1_024,
    ),
    accountRemoteSurfaceLimit: readBoundedInteger(
      "CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT",
      process.env.CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT,
      16,
      1,
      10_000,
    ),
    accountUploadBytesPerMinute: readBoundedInteger(
      "CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE",
      process.env.CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE,
      256 * 1_024 * 1_024,
      1 * 1_024 * 1_024,
      64 * 1_024 * 1_024 * 1_024,
    ),
    accountUploadConcurrency: readBoundedInteger(
      "CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY",
      process.env.CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY,
      4,
      1,
      1_000,
    ),
    accountWebsocketLimit: readBoundedInteger(
      "CANTRIP_ACCOUNT_WEBSOCKET_LIMIT",
      process.env.CANTRIP_ACCOUNT_WEBSOCKET_LIMIT,
      32,
      1,
      10_000,
    ),
    appOrigins,
    authMode,
    authRateLimit: readBoundedInteger(
      "CANTRIP_AUTH_RATE_LIMIT",
      process.env.CANTRIP_AUTH_RATE_LIMIT,
      10,
      1,
      1_000,
    ),
    bootstrapMode,
    coordinationMaxInstances: readBoundedInteger(
      "CANTRIP_COORDINATION_MAX_INSTANCES",
      process.env.CANTRIP_COORDINATION_MAX_INSTANCES,
      1,
      1,
      32,
    ),
    coordinationPresenceTtlMs: readBoundedInteger(
      "CANTRIP_COORDINATION_PRESENCE_TTL_MS",
      process.env.CANTRIP_COORDINATION_PRESENCE_TTL_MS,
      30_000,
      5_000,
      300_000,
    ),
    dataDirectory: path.resolve(
      process.cwd(),
      process.env.CANTRIP_DATA_DIR ?? "../.cantrip/dev",
    ),
    databaseUrl,
    deploymentMode,
    agentModel: process.env.CANTRIP_AGENT_MODEL ?? "gemma4:26b",
    agentModelProvider: process.env.CANTRIP_AGENT_MODEL_PROVIDER ?? "ollama",
    ollamaBaseUrl:
      process.env.CANTRIP_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    host,
    metricsToken,
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
    pairingRateLimitPerMinute: readBoundedInteger(
      "CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE",
      process.env.CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE,
      20,
      1,
      10_000,
    ),
    port,
    publicOrigin,
    publicRegistration: readBoolean(
      "CANTRIP_PUBLIC_REGISTRATION",
      process.env.CANTRIP_PUBLIC_REGISTRATION,
    ),
    redisUrl,
    sessionTtlSeconds: readBoundedInteger(
      "CANTRIP_SESSION_TTL_SECONDS",
      process.env.CANTRIP_SESSION_TTL_SECONDS,
      30 * 24 * 60 * 60,
      300,
      365 * 24 * 60 * 60,
    ),
    codeSurfaceHost,
    codeSurfaceOrigin: normalizedCodeSurfaceOrigin,
    codeSurfacePort,
    workerToken,
    remoteSurfaceWebRtc: readRemoteSurfaceWebRtcConfig(),
    requireHttps: deploymentMode === "hosted",
    secretEncryption,
    serverInstanceId,
    trustedProxies,
    uploadLimitBytes: readBoundedInteger(
      "CANTRIP_UPLOAD_LIMIT_BYTES",
      process.env.CANTRIP_UPLOAD_LIMIT_BYTES,
      25 * 1_024 * 1_024,
      1_024 * 1_024,
      1_024 * 1_024 * 1_024,
    ),
    uploadRateLimitPerMinute: readBoundedInteger(
      "CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE",
      process.env.CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE,
      30,
      1,
      10_000,
    ),
    websocketHandshakeRatePerMinute: readBoundedInteger(
      "CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE",
      process.env.CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE,
      120,
      1,
      10_000,
    ),
    websocketMaxPayloadBytes: readBoundedInteger(
      "CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES",
      process.env.CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES,
      8 * 1_024 * 1_024,
      64 * 1_024,
      64 * 1_024 * 1_024,
    ),
    workerCommandConcurrency: readBoundedInteger(
      "CANTRIP_WORKER_COMMAND_CONCURRENCY",
      process.env.CANTRIP_WORKER_COMMAND_CONCURRENCY,
      64,
      1,
      10_000,
    ),
    workerCommandRatePerMinute: readBoundedInteger(
      "CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE",
      process.env.CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE,
      1_200,
      60,
      100_000,
    ),
    workerRelayBytesPerMinute: readBoundedInteger(
      "CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE",
      process.env.CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE,
      256 * 1_024 * 1_024,
      1 * 1_024 * 1_024,
      64 * 1_024 * 1_024 * 1_024,
    ),
    workerRemoteSurfaceLimit: readBoundedInteger(
      "CANTRIP_WORKER_REMOTE_SURFACE_LIMIT",
      process.env.CANTRIP_WORKER_REMOTE_SURFACE_LIMIT,
      8,
      1,
      10_000,
    ),
    workerUploadBytesPerMinute: readBoundedInteger(
      "CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE",
      process.env.CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE,
      128 * 1_024 * 1_024,
      1 * 1_024 * 1_024,
      64 * 1_024 * 1_024 * 1_024,
    ),
  };
  if (config.cookieSameSite === "none" && !config.cookieSecure) {
    throw new Error(
      "CANTRIP_COOKIE_SAME_SITE=none requires CANTRIP_COOKIE_SECURE=true.",
    );
  }
  const instanceDivisor = config.coordinationMaxInstances ?? 1;
  if (instanceDivisor > 1 && !config.redisUrl) {
    throw new Error(
      "CANTRIP_COORDINATION_MAX_INSTANCES above 1 requires REDIS_URL.",
    );
  }
  const divideLimit = (name: string, value: number | undefined): number => {
    if (value === undefined || value < instanceDivisor) {
      throw new Error(
        `${name} must be at least CANTRIP_COORDINATION_MAX_INSTANCES.`,
      );
    }
    return Math.floor(value / instanceDivisor);
  };
  if (instanceDivisor > 1) {
    config.apiRateLimitPerMinute = divideLimit(
      "CANTRIP_API_RATE_LIMIT_PER_MINUTE",
      config.apiRateLimitPerMinute,
    );
    config.authRateLimit = divideLimit(
      "CANTRIP_AUTH_RATE_LIMIT",
      config.authRateLimit,
    );
    config.pairingRateLimitPerMinute = divideLimit(
      "CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE",
      config.pairingRateLimitPerMinute,
    );
    config.uploadRateLimitPerMinute = divideLimit(
      "CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE",
      config.uploadRateLimitPerMinute,
    );
    config.websocketHandshakeRatePerMinute = divideLimit(
      "CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE",
      config.websocketHandshakeRatePerMinute,
    );
    config.accountCommandConcurrency = divideLimit(
      "CANTRIP_ACCOUNT_COMMAND_CONCURRENCY",
      config.accountCommandConcurrency,
    );
    config.accountCommandRatePerMinute = divideLimit(
      "CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE",
      config.accountCommandRatePerMinute,
    );
    config.accountRelayBytesPerMinute = divideLimit(
      "CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE",
      config.accountRelayBytesPerMinute,
    );
    config.accountRemoteSurfaceLimit = divideLimit(
      "CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT",
      config.accountRemoteSurfaceLimit,
    );
    config.accountUploadBytesPerMinute = divideLimit(
      "CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE",
      config.accountUploadBytesPerMinute,
    );
    config.accountUploadConcurrency = divideLimit(
      "CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY",
      config.accountUploadConcurrency,
    );
    config.accountWebsocketLimit = divideLimit(
      "CANTRIP_ACCOUNT_WEBSOCKET_LIMIT",
      config.accountWebsocketLimit,
    );
    config.workerCommandConcurrency = divideLimit(
      "CANTRIP_WORKER_COMMAND_CONCURRENCY",
      config.workerCommandConcurrency,
    );
    config.workerCommandRatePerMinute = divideLimit(
      "CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE",
      config.workerCommandRatePerMinute,
    );
    config.workerRelayBytesPerMinute = divideLimit(
      "CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE",
      config.workerRelayBytesPerMinute,
    );
    config.workerRemoteSurfaceLimit = divideLimit(
      "CANTRIP_WORKER_REMOTE_SURFACE_LIMIT",
      config.workerRemoteSurfaceLimit,
    );
    config.workerUploadBytesPerMinute = divideLimit(
      "CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE",
      config.workerUploadBytesPerMinute,
    );
  }
  resolveCodeSurfaceConfig(config);
  return config;
}
