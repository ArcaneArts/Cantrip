import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubHostedInfrastructure(): void {
  vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
  vi.stubEnv("CANTRIP_BOOTSTRAP_MODE", "hosted");
  vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
  vi.stubEnv("CANTRIP_ADMIN_EMAIL", "admin@cantrip.test");
  vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
  vi.stubEnv("DATABASE_URL", "postgres://cantrip:test@db/cantrip");
  vi.stubEnv("CANTRIP_APP_ORIGINS", "https://app.cantrip.test");
  vi.stubEnv("CANTRIP_PUBLIC_ORIGIN", "https://api.cantrip.test");
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
      bandwidthUsageFlushIntervalMs: 60_000,
      bootstrapMode: "pnpm-dev",
      deploymentMode: "local",
      host: "127.0.0.1",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
      licenseWhitelistEnabled: true,
    });
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
    vi.stubEnv("CANTRIP_ADMIN_EMAIL", "admin@cantrip.test");
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
    vi.stubEnv("CANTRIP_TRUSTED_PROXIES", "loopback");
    expect(readServerConfig().secretEncryption).toMatchObject({
      activeKeyId: "current",
      keys: [{ id: "old" }, { id: "current" }],
    });
  });

  it("requires explicit secure origins, PostgreSQL, and trusted proxies in hosted mode", () => {
    stubHostedInfrastructure();
    vi.stubEnv("REDIS_URL", "rediss://redis.cantrip.test:6380");
    vi.stubEnv("CANTRIP_SERVER_INSTANCE_ID", "relay-us-central-1");
    vi.stubEnv("CANTRIP_COORDINATION_PRESENCE_TTL_MS", "45000");
    vi.stubEnv("CANTRIP_SCHEDULER_LEASE_TTL_MS", "180000");
    expect(readServerConfig()).toMatchObject({
      appOrigins: ["https://app.cantrip.test"],
      databaseUrl: "postgres://cantrip:test@db/cantrip",
      publicOrigin: "https://api.cantrip.test",
      requireHttps: true,
      redisUrl: "rediss://redis.cantrip.test:6380",
      serverInstanceId: "relay-us-central-1",
      coordinationPresenceTtlMs: 45_000,
      schedulerLeaseTtlMs: 180_000,
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

  it("validates optional shared relay coordination configuration", () => {
    vi.stubEnv("REDIS_URL", "https://not-redis.test");
    expect(() => readServerConfig()).toThrow(/REDIS_URL.*redis/i);
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    vi.stubEnv("CANTRIP_SERVER_INSTANCE_ID", "invalid\ninstance");
    expect(() => readServerConfig()).toThrow(/SERVER_INSTANCE_ID/i);
    vi.stubEnv("CANTRIP_SERVER_INSTANCE_ID", "relay-1");
    vi.stubEnv("CANTRIP_COORDINATION_PRESENCE_TTL_MS", "1000");
    expect(() => readServerConfig()).toThrow(/PRESENCE_TTL/i);
    vi.stubEnv("CANTRIP_COORDINATION_PRESENCE_TTL_MS", "30000");
    vi.stubEnv("CANTRIP_SCHEDULER_LEASE_TTL_MS", "1000");
    expect(() => readServerConfig()).toThrow(/SCHEDULER_LEASE_TTL/i);
  });

  it("partitions global quotas safely across the configured replica ceiling", () => {
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    vi.stubEnv("CANTRIP_COORDINATION_MAX_INSTANCES", "4");
    expect(readServerConfig()).toMatchObject({
      coordinationMaxInstances: 4,
      accountCommandConcurrency: 32,
      accountRelayBytesPerMinute: 134_217_728,
      accountRemoteSurfaceLimit: 4,
      accountUploadConcurrency: 1,
      workerCommandConcurrency: 16,
      workerRelayBytesPerMinute: 67_108_864,
      workerRemoteSurfaceLimit: 2,
    });

    vi.stubEnv("CANTRIP_COORDINATION_MAX_INSTANCES", "5");
    expect(() => readServerConfig()).toThrow(
      /ACCOUNT_UPLOAD_CONCURRENCY.*MAX_INSTANCES/i,
    );
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
    vi.stubEnv("CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT", "12");
    vi.stubEnv("CANTRIP_WORKER_REMOTE_SURFACE_LIMIT", "6");
    vi.stubEnv("CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE", "33554432");
    vi.stubEnv("CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE", "16777216");
    vi.stubEnv("CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE", "67108864");
    vi.stubEnv("CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE", "33554432");
    vi.stubEnv("CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS", "3000");
    vi.stubEnv("CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES", "65536");
    vi.stubEnv("CANTRIP_BANDWIDTH_USAGE_MAX_BUFFERED_ENTRIES", "2048");
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_HOURLY_RETENTION_DAYS", "14");
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_DAILY_RETENTION_DAYS", "365");
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_FLUSH_RETENTION_DAYS", "5");
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS", "1800000");
    vi.stubEnv("CANTRIP_STORAGE_RECONCILIATION_INTERVAL_MS", "1200000");
    vi.stubEnv("CANTRIP_METRICS_TOKEN", "m".repeat(32));
    expect(readServerConfig()).toMatchObject({
      apiBodyLimitBytes: 65_536,
      apiRateLimitPerMinute: 900,
      accountCommandConcurrency: 80,
      accountCommandRatePerMinute: 1_800,
      accountRelayBytesPerMinute: 67_108_864,
      accountRemoteSurfaceLimit: 12,
      accountUploadBytesPerMinute: 33_554_432,
      accountUploadConcurrency: 3,
      accountWebsocketLimit: 20,
      bandwidthUsageFlushIntervalMs: 3_000,
      bandwidthUsageFlushThresholdBytes: 65_536,
      bandwidthUsageMaxBufferedEntries: 2_048,
      accountUsageDailyRetentionDays: 365,
      accountUsageFlushRetentionDays: 5,
      accountUsageHourlyRetentionDays: 14,
      accountUsageMaintenanceIntervalMs: 1_800_000,
      pairingRateLimitPerMinute: 9,
      metricsToken: "m".repeat(32),
      storageReconciliationIntervalMs: 1_200_000,
      uploadLimitBytes: 1_048_576,
      uploadRateLimitPerMinute: 12,
      websocketHandshakeRatePerMinute: 90,
      websocketMaxPayloadBytes: 131_072,
      workerCommandConcurrency: 40,
      workerCommandRatePerMinute: 800,
      workerRelayBytesPerMinute: 33_554_432,
      workerRemoteSurfaceLimit: 6,
      workerUploadBytesPerMinute: 16_777_216,
    });

    vi.stubEnv("CANTRIP_API_BODY_LIMIT_BYTES", "100");
    expect(() => readServerConfig()).toThrow(/API_BODY_LIMIT/i);
    vi.stubEnv("CANTRIP_API_BODY_LIMIT_BYTES", "65536");
    vi.stubEnv("CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS", "100");
    expect(() => readServerConfig()).toThrow(/BANDWIDTH_USAGE_FLUSH_INTERVAL/i);
    vi.stubEnv("CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS", "3000");
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS", "100");
    expect(() => readServerConfig()).toThrow(/USAGE_MAINTENANCE_INTERVAL/i);
    vi.stubEnv("CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS", "1800000");
    vi.stubEnv("CANTRIP_METRICS_TOKEN", "too-short");
    expect(() => readServerConfig()).toThrow(/METRICS_TOKEN/i);
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
    vi.stubEnv("CANTRIP_ADMIN_EMAIL", "owner@example.com");
    vi.stubEnv("CANTRIP_PUBLIC_REGISTRATION", "true");
    expect(readServerConfig()).toMatchObject({
      adminEmail: "owner@example.com",
      adminBootstrapToken: "a".repeat(32),
      authMode: "accounts",
      licenseWhitelistEnabled: true,
      publicRegistration: true,
    });
  });

  it("requires a valid administrator email unless licensing is disabled", () => {
    vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
    expect(() => readServerConfig()).toThrow(/ADMIN_EMAIL/i);

    vi.stubEnv("CANTRIP_ADMIN_EMAIL", "not-an-email");
    expect(() => readServerConfig()).toThrow(/valid email/i);

    vi.stubEnv("CANTRIP_ADMIN_EMAIL", "");
    vi.stubEnv("CANTRIP_LICENSE_WHITELIST_ENABLED", "false");
    expect(readServerConfig()).toMatchObject({
      adminEmail: undefined,
      authMode: "accounts",
      licenseWhitelistEnabled: false,
    });
  });

  it("requires Secure cookies when SameSite is none", () => {
    vi.stubEnv("CANTRIP_COOKIE_SAME_SITE", "none");
    vi.stubEnv("CANTRIP_COOKIE_SECURE", "false");
    expect(() => readServerConfig()).toThrow(/requires.*secure/i);

    vi.stubEnv("CANTRIP_COOKIE_SAME_SITE", "sometimes");
    expect(() => readServerConfig()).toThrow(/expected lax, none, or strict/i);
  });

  it("defaults to direct host ICE and accepts optional STUN and TURN", () => {
    expect(readServerConfig().remoteSurfaceWebRtc).toEqual({
      iceTransportPolicy: "all",
      negotiationTimeoutMs: 8_000,
      stunUrls: [],
      turn: undefined,
    });
    vi.stubEnv("CANTRIP_STUN_URLS", "stun:stun.cantrip.art:3478");
    vi.stubEnv(
      "CANTRIP_TURN_URLS",
      "turn:relay.cantrip.art:3478?transport=udp,turns:relay.cantrip.art:5349",
    );
    vi.stubEnv("CANTRIP_TURN_SHARED_SECRET", "server-only-secret");
    vi.stubEnv("CANTRIP_TURN_TTL_SECONDS", "900");
    expect(readServerConfig().remoteSurfaceWebRtc).toEqual({
      iceTransportPolicy: "all",
      negotiationTimeoutMs: 8_000,
      stunUrls: ["stun:stun.cantrip.art:3478"],
      turn: {
        urls: [
          "turn:relay.cantrip.art:3478?transport=udp",
          "turns:relay.cantrip.art:5349",
        ],
        sharedSecret: "server-only-secret",
        ttlSeconds: 900,
      },
    });

    vi.stubEnv("CANTRIP_TURN_URLS", "https://relay.cantrip.art");
    expect(() => readServerConfig()).toThrow(/turn: or turns:/i);

    vi.stubEnv("CANTRIP_TURN_URLS", "");
    expect(() => readServerConfig()).toThrow(/configured together/i);

    vi.stubEnv("CANTRIP_TURN_SHARED_SECRET", "");
    vi.stubEnv("CANTRIP_STUN_URLS", "https://stun.cantrip.art");
    expect(() => readServerConfig()).toThrow(/stun: or stuns:/i);

    vi.stubEnv("CANTRIP_STUN_URLS", "");
    vi.stubEnv("CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY", "relay");
    expect(() => readServerConfig()).toThrow(/requires TURN/i);
  });

  it("bounds the separate TURN-free WorkerLink peer policy", () => {
    expect(readServerConfig().workerLinkPeer).toMatchObject({
      directRoutes: { local: true, lan: true, wan: true },
      relayOnly: false,
      stunUrls: ["stun:stun.cloudflare.com:3478"],
      interfacePolicy: { mode: "default", interfaces: [] },
      vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
      negotiationTimeoutMs: 8_000,
      upgradeProbeTimeoutMs: 15_000,
      maxPeerSessionsPerClient: 4,
      maxPeerSessionsPerWorker: 32,
    });

    vi.stubEnv("CANTRIP_WORKER_LINK_LOCAL_ENABLED", "false");
    vi.stubEnv("CANTRIP_WORKER_LINK_LAN_ENABLED", "false");
    vi.stubEnv("CANTRIP_WORKER_LINK_WAN_ENABLED", "true");
    vi.stubEnv(
      "CANTRIP_WORKER_LINK_STUN_URLS",
      "stun:one.example.test:3478,stuns:two.example.test:5349",
    );
    vi.stubEnv("CANTRIP_WORKER_LINK_INTERFACE_DENYLIST", "en9,bridge0");
    vi.stubEnv("CANTRIP_WORKER_LINK_VPN_LAN_ALLOWLIST", "corp-vpn0");
    vi.stubEnv("CANTRIP_WORKER_LINK_NEGOTIATION_TIMEOUT_MS", "12000");
    vi.stubEnv("CANTRIP_WORKER_LINK_UPGRADE_PROBE_TIMEOUT_MS", "45000");
    vi.stubEnv("CANTRIP_WORKER_LINK_MAX_PEER_SESSIONS_PER_CLIENT", "8");
    vi.stubEnv("CANTRIP_WORKER_LINK_MAX_PEER_SESSIONS_PER_WORKER", "64");
    vi.stubEnv(
      "CANTRIP_WORKER_LINK_LANE_LIMITS",
      JSON.stringify({
        realtime: { maxQueuedFrames: 32, maxQueuedBytes: 2 * 1_024 * 1_024 },
        stream: { maxBytesPerSecond: 256 * 1_024 * 1_024 },
      }),
    );
    expect(readServerConfig().workerLinkPeer).toMatchObject({
      directRoutes: { local: false, lan: false, wan: true },
      stunUrls: ["stun:one.example.test:3478", "stuns:two.example.test:5349"],
      interfacePolicy: {
        mode: "denylist",
        interfaces: ["en9", "bridge0"],
      },
      vpnPolicy: { defaultRoute: "wan", lanAllowlist: ["corp-vpn0"] },
      negotiationTimeoutMs: 12_000,
      upgradeProbeTimeoutMs: 45_000,
      maxPeerSessionsPerClient: 8,
      maxPeerSessionsPerWorker: 64,
      laneLimits: {
        realtime: {
          maxQueuedFrames: 32,
          maxQueuedBytes: 2 * 1_024 * 1_024,
        },
        stream: { maxBytesPerSecond: 256 * 1_024 * 1_024 },
      },
    });
  });

  it("fails closed for contradictory or malformed WorkerLink peer controls", () => {
    vi.stubEnv("CANTRIP_WORKER_LINK_RELAY_ONLY", "true");
    expect(readServerConfig().workerLinkPeer).toMatchObject({
      directRoutes: { local: false, lan: false, wan: false },
      relayOnly: true,
      stunUrls: [],
    });

    vi.stubEnv("CANTRIP_WORKER_LINK_RELAY_ONLY", "false");
    vi.stubEnv("CANTRIP_WORKER_LINK_INTERFACE_ALLOWLIST", "en0");
    vi.stubEnv("CANTRIP_WORKER_LINK_INTERFACE_DENYLIST", "en9");
    expect(() => readServerConfig()).toThrow(/only one.*INTERFACE/i);

    vi.stubEnv("CANTRIP_WORKER_LINK_INTERFACE_DENYLIST", "");
    vi.stubEnv("CANTRIP_WORKER_LINK_STUN_URLS", "turn:relay.example.test");
    expect(() => readServerConfig()).toThrow(/STUN URLs.*stun:/i);

    vi.stubEnv("CANTRIP_WORKER_LINK_STUN_URLS", "");
    vi.stubEnv("CANTRIP_WORKER_LINK_LANE_LIMITS", "{not-json");
    expect(() => readServerConfig()).toThrow(/valid JSON/i);

    vi.stubEnv(
      "CANTRIP_WORKER_LINK_LANE_LIMITS",
      JSON.stringify({ realtime: { maxQueuedFrames: 0 } }),
    );
    expect(() => readServerConfig()).toThrow(/LANE_LIMITS/i);
  });
});
