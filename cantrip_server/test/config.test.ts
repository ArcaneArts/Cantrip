import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubHostedInfrastructure(): void {
  vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
  vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "hosted");
  vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
  vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
  vi.stubEnv("DATABASE_URL", "postgres://cantrip:test@db/cantrip");
  vi.stubEnv("CANTRIP_APP_ORIGINS", "https://app.cantrip.test");
  vi.stubEnv("CANTRIP_PUBLIC_ORIGIN", "https://api.cantrip.test");
  vi.stubEnv("CANTRIP_CODE_SURFACE_ORIGIN", "https://code.cantrip.test");
  vi.stubEnv("CANTRIP_TRUSTED_PROXIES", "loopback,10.0.0.0/8");
  vi.stubEnv(
    "CANTRIP_SECRET_ENCRYPTION_KEYS",
    JSON.stringify({ primary: Buffer.alloc(32, 1).toString("base64") }),
  );
}

describe("server configuration safety", () => {
  it("defaults to anonymous loopback development", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "127.0.0.1");
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "local");
    vi.stubEnv("CANTRIP_AUTH_MODE", "none");

    expect(readServerConfig()).toMatchObject({
      agentModel: "gemma4:26b",
      agentModelProvider: "ollama",
      allowInsecureRemote: false,
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      deploymentMode: "local",
      host: "127.0.0.1",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
      codeSurfaceHost: "127.0.0.1",
      codeSurfaceOrigin: "http://127.0.0.1:4311",
      codeSurfacePort: 4311,
    });
  });

  it("validates an independently addressable Code surface origin", () => {
    vi.stubEnv("CANTRIP_CODE_SURFACE_PORT", "5311");
    vi.stubEnv("CANTRIP_CODE_SURFACE_ORIGIN", "https://code.cantrip.example");
    expect(readServerConfig()).toMatchObject({
      codeSurfacePort: 5311,
      codeSurfaceOrigin: "https://code.cantrip.example",
    });

    vi.stubEnv(
      "CANTRIP_CODE_SURFACE_ORIGIN",
      "https://code.cantrip.example/not-an-origin",
    );
    expect(() => readServerConfig()).toThrow(/without a path/i);
  });

  it("refuses to expose the no-auth foundation beyond loopback", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");

    expect(() => readServerConfig()).toThrow(/remote access is disabled/);
  });

  it("never permits anonymous hosted mode through the unsafe local opt-in", () => {
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "true");
    expect(() => readServerConfig()).toThrow(/require.*auth_mode/i);
  });

  it("requires a versioned encryption keyring for hosted secrets", () => {
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
    vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
    vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "hosted");
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
    expect(() => readServerConfig()).toThrow(/encryption_keys/i);

    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const currentKey = Buffer.alloc(32, 2).toString("base64");
    vi.stubEnv(
      "CANTRIP_SECRET_ENCRYPTION_KEYS",
      JSON.stringify({ old: oldKey, current: currentKey }),
    );
    expect(() => readServerConfig()).toThrow(/active.*key/i);

    vi.stubEnv("CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID", "current");
    vi.stubEnv("DATABASE_URL", "postgres://cantrip:test@db/cantrip");
    vi.stubEnv("CANTRIP_APP_ORIGINS", "https://app.cantrip.test");
    vi.stubEnv("CANTRIP_PUBLIC_ORIGIN", "https://api.cantrip.test");
    vi.stubEnv("CANTRIP_CODE_SURFACE_ORIGIN", "https://code.cantrip.test");
    vi.stubEnv("CANTRIP_TRUSTED_PROXIES", "loopback");
    expect(readServerConfig().secretEncryption).toMatchObject({
      activeKeyId: "current",
      keys: [{ id: "old" }, { id: "current" }],
    });
  });

  it("requires explicit secure origins, PostgreSQL, and trusted proxies in hosted mode", () => {
    stubHostedInfrastructure();
    expect(readServerConfig()).toMatchObject({
      appOrigins: ["https://app.cantrip.test"],
      databaseUrl: "postgres://cantrip:test@db/cantrip",
      publicOrigin: "https://api.cantrip.test",
      codeSurfaceOrigin: "https://code.cantrip.test",
      requireHttps: true,
      trustedProxies: ["loopback", "10.0.0.0/8"],
    });

    vi.stubEnv("CANTRIP_APP_ORIGINS", "*");
    expect(() => readServerConfig()).toThrow(/wildcard/i);
    vi.stubEnv("CANTRIP_APP_ORIGINS", "http://app.cantrip.test");
    expect(() => readServerConfig()).toThrow(/must use HTTPS/i);
    vi.stubEnv("CANTRIP_APP_ORIGINS", "https://app.cantrip.test");
    vi.stubEnv("CANTRIP_TRUSTED_PROXIES", "proxy.example.test");
    expect(() => readServerConfig()).toThrow(/IP addresses.*CIDR/i);
    vi.stubEnv("CANTRIP_TRUSTED_PROXIES", "loopback");
    vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "standalone");
    expect(() => readServerConfig()).toThrow(/BOOTSTRAP_MODE=hosted/i);
    vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "hosted");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "true");
    expect(() => readServerConfig()).toThrow(/not permitted/i);
  });

  it("bounds public payload, rate, connection, and command limits", () => {
    vi.stubEnv("CANTRIP_API_BODY_LIMIT_BYTES", "65536");
    vi.stubEnv("CANTRIP_UPLOAD_LIMIT_BYTES", "1048576");
    vi.stubEnv("CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES", "131072");
    vi.stubEnv("CANTRIP_API_RATE_LIMIT_PER_MINUTE", "900");
    vi.stubEnv("CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE", "9");
    vi.stubEnv("CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE", "12");
    vi.stubEnv("CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE", "90");
    vi.stubEnv("CANTRIP_ACCOUNT_WEBSOCKET_LIMIT", "20");
    vi.stubEnv("CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY", "3");
    vi.stubEnv("CANTRIP_ACCOUNT_COMMAND_CONCURRENCY", "80");
    vi.stubEnv("CANTRIP_WORKER_COMMAND_CONCURRENCY", "40");
    vi.stubEnv("CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE", "1800");
    vi.stubEnv("CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE", "800");
    expect(readServerConfig()).toMatchObject({
      apiBodyLimitBytes: 65_536,
      apiRateLimitPerMinute: 900,
      accountCommandConcurrency: 80,
      accountCommandRatePerMinute: 1_800,
      accountUploadConcurrency: 3,
      accountWebsocketLimit: 20,
      pairingRateLimitPerMinute: 9,
      uploadLimitBytes: 1_048_576,
      uploadRateLimitPerMinute: 12,
      websocketHandshakeRatePerMinute: 90,
      websocketMaxPayloadBytes: 131_072,
      workerCommandConcurrency: 40,
      workerCommandRatePerMinute: 800,
    });

    vi.stubEnv("CANTRIP_API_BODY_LIMIT_BYTES", "100");
    expect(() => readServerConfig()).toThrow(/API_BODY_LIMIT/i);
  });

  it("confines shared worker tokens to explicit loopback dev bootstraps", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "true");
    vi.stubEnv("CANTRIP_WORKER_TOKEN", "a-unique-remote-worker-token");
    expect(() => readServerConfig()).toThrow(/restricted.*loopback/i);

    vi.stubEnv("CANTRIP_SERVER_HOST", "127.0.0.1");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "false");
    vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "standalone");
    expect(() => readServerConfig()).toThrow(/one-time link code/i);

    vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "pnpm-dev");
    expect(readServerConfig().workerToken).toBe("a-unique-remote-worker-token");
  });

  it("requires an Argon2id hash for single-user password mode", () => {
    vi.stubEnv("CANTRIP_AUTH_MODE", "password");
    expect(() => readServerConfig()).toThrow(/CANTRIP_PASSWORD_HASH/);

    vi.stubEnv(
      "CANTRIP_PASSWORD_HASH",
      "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnaWVzdA",
    );
    expect(readServerConfig()).toMatchObject({
      authMode: "password",
      publicRegistration: false,
      sessionTtlSeconds: 2_592_000,
    });
  });

  it("accepts accounts mode and validates first-admin secrets", () => {
    vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
    vi.stubEnv("CANTRIP_ADMIN_BOOTSTRAP_TOKEN", "too-short");
    expect(() => readServerConfig()).toThrow(/at least 32/);

    vi.stubEnv("CANTRIP_ADMIN_BOOTSTRAP_TOKEN", "a".repeat(32));
    vi.stubEnv("CANTRIP_PUBLIC_REGISTRATION", "true");
    expect(readServerConfig()).toMatchObject({
      adminBootstrapToken: "a".repeat(32),
      authMode: "accounts",
      publicRegistration: true,
    });
  });

  it("requires Secure cookies when SameSite is none", () => {
    vi.stubEnv("CANTRIP_COOKIE_SAME_SITE", "none");
    vi.stubEnv("CANTRIP_COOKIE_SECURE", "false");
    expect(() => readServerConfig()).toThrow(/requires.*secure/i);

    vi.stubEnv("CANTRIP_COOKIE_SAME_SITE", "sometimes");
    expect(() => readServerConfig()).toThrow(/expected lax, none, or strict/i);
  });

  it("accepts complete TURN configuration and rejects partial or direct URLs", () => {
    vi.stubEnv(
      "CANTRIP_TURN_URLS",
      "turn:relay.cantrip.art:3478?transport=udp,turns:relay.cantrip.art:5349",
    );
    vi.stubEnv("CANTRIP_TURN_SHARED_SECRET", "server-only-secret");
    vi.stubEnv("CANTRIP_TURN_TTL_SECONDS", "900");
    expect(readServerConfig().remoteSurfaceWebRtc).toEqual({
      urls: [
        "turn:relay.cantrip.art:3478?transport=udp",
        "turns:relay.cantrip.art:5349",
      ],
      sharedSecret: "server-only-secret",
      ttlSeconds: 900,
      negotiationTimeoutMs: 8_000,
    });

    vi.stubEnv("CANTRIP_TURN_URLS", "https://relay.cantrip.art");
    expect(() => readServerConfig()).toThrow(/turn: or turns:/i);

    vi.stubEnv("CANTRIP_TURN_URLS", "");
    expect(() => readServerConfig()).toThrow(/configured together/i);
  });
});
