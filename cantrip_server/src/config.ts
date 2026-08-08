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

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "4310", 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid CANTRIP_SERVER_PORT: ${value}`);
  }

  return port;
}

export interface ServerConfig {
  allowInsecureRemote: boolean;
  appOrigins: string[];
  authMode: AuthMode;
  bootstrapMode: BootstrapMode;
  dataDirectory: string;
  databaseUrl?: string;
  deploymentMode: DeploymentMode;
  agentModel: string;
  agentModelProvider: string;
  ollamaBaseUrl: string;
  host: string;
  port: number;
  workerToken: string;
  remoteSurfaceWebRtc?: RemoteSurfaceTurnConfig;
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
  const allowInsecureRemote = readBoolean(
    "CANTRIP_ALLOW_INSECURE_REMOTE",
    process.env.CANTRIP_ALLOW_INSECURE_REMOTE,
  );

  if (authMode !== "none") {
    throw new Error(
      `CANTRIP_AUTH_MODE=${authMode} is planned but not implemented. Use none for the local foundation.`,
    );
  }

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if ((!loopback || deploymentMode === "hosted") && !allowInsecureRemote) {
    throw new Error(
      "Unauthenticated remote access is disabled. Set CANTRIP_ALLOW_INSECURE_REMOTE=true only behind a trusted network or authenticating reverse proxy.",
    );
  }
  if (
    (!loopback || deploymentMode === "hosted") &&
    workerToken === DEFAULT_WORKER_TOKEN
  ) {
    throw new Error(
      "Remote deployments must set a unique CANTRIP_WORKER_TOKEN.",
    );
  }

  return {
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
    port: readPort(process.env.CANTRIP_SERVER_PORT),
    workerToken,
    remoteSurfaceWebRtc: readRemoteSurfaceWebRtcConfig(),
  };
}
