import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const dataDirectories: string[] = [];
const applicationOrigin = "https://app.cantrip.test";
const publicOrigin = "https://api.cantrip.test";

async function testConfig(
  overrides: Partial<ServerConfig> = {},
): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-http-hardening-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [applicationOrigin],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    workerToken: "http-hardening-test-worker",
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("public HTTP hardening", () => {
  it("does not register the removed durable workflow API", async () => {
    const config = await testConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      for (const [method, url] of [
        ["GET", "/api/workflows"],
        ["POST", "/api/workflows"],
        ["GET", "/api/workflows/workflow-one"],
        ["POST", "/api/workflow-runs"],
        ["GET", "/api/workflow-runs/run-one"],
        ["POST", "/api/workflow-triggers"],
        ["POST", "/api/workflow-hooks/trigger-one"],
        ["POST", "/api/chats/chat-one/workflow-generation"],
        ["GET", "/api/projects/project-one/workflow-repository"],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("advertises and measures retained legacy feature transports", async () => {
    const config = await testConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const deprecated = await app.inject({
        method: "POST",
        url: "/api/terminals/missing/direct",
        payload: { clientId: "compatibility-client" },
      });
      expect(deprecated.statusCode).toBe(404);
      expect(deprecated.headers.deprecation).toBe("@1787788800");
      expect(deprecated.headers.link).toContain('rel="deprecation"');

      const health = (
        await app.inject({ method: "GET", url: "/api/health" })
      ).json();
      expect(health.operations.workerLinkRelay).toMatchObject({
        channels: 0,
        connections: 0,
        queuedBytes: 0,
        queuedFrames: 0,
      });
      expect(
        health.operations.legacyFeatureTransports.requestsByEndpoint,
      ).toMatchObject({ "terminal-direct": 1 });

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain(
        'cantrip_legacy_feature_transport_requests_total{endpoint="terminal-direct"} 1',
      );
    } finally {
      await app.close();
    }
  });

  it("sets defensive API headers and accepts only the configured HTTPS proxy route", async () => {
    const config = await testConfig({
      publicOrigin,
      requireHttps: true,
      trustedProxies: ["loopback"],
    });
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    const proxyHeaders = {
      host: "api.cantrip.test",
      origin: applicationOrigin,
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-host": "api.cantrip.test",
      "x-forwarded-proto": "https",
    };

    try {
      const accepted = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: proxyHeaders,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers).toMatchObject({
        "cache-control": "no-store",
        "content-security-policy": expect.stringContaining(
          "frame-ancestors 'none'",
        ),
        "permissions-policy": expect.stringContaining("camera=()"),
        "referrer-policy": "no-referrer",
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "x-permitted-cross-domain-policies": "none",
        "x-request-id": expect.any(String),
      });

      const insecure = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { ...proxyHeaders, "x-forwarded-proto": "http" },
      });
      expect(insecure.statusCode).toBe(400);
      expect(insecure.json().error).toMatch(/HTTPS/i);

      const wrongHost = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: {
          ...proxyHeaders,
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
        },
      });
      expect(wrongHost.statusCode).toBe(400);

      const wrongOrigin = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { ...proxyHeaders, origin: "https://attacker.example" },
      });
      expect(wrongOrigin.statusCode).toBe(403);

      const ambiguous = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { ...proxyHeaders, forwarded: "proto=https" },
      });
      expect(ambiguous.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects forwarding headers when no trusted proxy is configured", async () => {
    const config = await testConfig({
      apiBodyLimitBytes: 16 * 1_024,
      uploadLimitBytes: 1_024 * 1_024,
    });
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/trusted proxy/i);

      const oversizedJson = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "x".repeat(20 * 1_024) },
      });
      expect(oversizedJson.statusCode).toBe(413);

      const oversizedUpload = await app.inject({
        method: "POST",
        url: "/api/chats/missing/attachments",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(1_024 * 1_024 + 1),
      });
      expect(oversizedUpload.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("separates process liveness from database readiness", async () => {
    const config = await testConfig();
    const database = await connectDatabase(config);
    let databaseReady = true;
    const app = await buildApp({
      config,
      database: {
        ...database,
        async ping() {
          if (!databaseReady) throw new Error("database unavailable");
          await database.ping();
        },
      },
      logger: false,
    });
    try {
      const live = await app.inject({ method: "GET", url: "/healthz" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ status: "alive" });

      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: "ready",
        database: { status: "ready" },
      });

      databaseReady = false;
      const unavailable = await app.inject({ method: "GET", url: "/readyz" });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({
        status: "not-ready",
        database: { status: "unavailable" },
      });
      expect(
        (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("protects aggregate Prometheus metrics with an operator token", async () => {
    const config = await testConfig({
      authMode: "accounts",
      metricsToken: "operator-metrics-token-with-32-characters",
      publicRegistration: true,
      secretEncryption: {
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
      },
    });
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
      ).toBe(401);
      const metrics = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: {
          authorization: "Bearer operator-metrics-token-with-32-characters",
        },
      });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers["content-type"]).toContain("text/plain");
      expect(metrics.body).toContain("cantrip_http_requests_total");
      expect(metrics.body).toContain("cantrip_database_ready");
      expect(metrics.body).toContain("cantrip_workers_connected");
      expect(metrics.body).toContain(
        'cantrip_tunnel_bytes_total{direction="source_to_destination"}',
      );
      expect(metrics.body).toContain(
        'cantrip_tunnel_terminations_total{reason="protocol-error"}',
      );
      expect(metrics.body).toContain("cantrip_scheduler_scans_total");
      expect(metrics.body).toContain(
        "cantrip_account_usage_storage_reconciliations_total",
      );
      expect(metrics.body).toContain(
        "cantrip_account_usage_bandwidth_buffered_bytes",
      );
      expect(metrics.body).toContain(
        "cantrip_account_usage_history_maintenance_total",
      );
      expect(metrics.body).not.toContain("owner_id");
      expect(metrics.body).not.toContain("operator-metrics-token");
    } finally {
      await app.close();
    }
  });

  it("requires a one-time first-owner token only while a closed hosted server is empty", async () => {
    const config = await testConfig({
      authMode: "accounts",
      bootstrapMode: "hosted",
      deploymentMode: "hosted",
      publicRegistration: false,
      secretEncryption: {
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
      },
    });
    const database = await connectDatabase(config);
    try {
      await expect(
        buildApp({ config, database, logger: false }),
      ).rejects.toThrow(/ADMIN_BOOTSTRAP_TOKEN/i);
    } finally {
      await database.close();
    }
  });

  it("rate limits API, pairing, and upload traffic independently", async () => {
    const config = await testConfig({
      apiRateLimitPerMinute: 2,
      deploymentMode: "hosted",
      pairingRateLimitPerMinute: 1,
      secretEncryption: {
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
      },
      uploadRateLimitPerMinute: 1,
    });
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode,
      ).toBe(200);
      const apiLimited = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
      });
      expect(apiLimited.statusCode).toBe(429);
      expect(apiLimited.headers["retry-after"]).toBeDefined();

      const invalidPairing = {
        method: "POST" as const,
        url: "/api/workers/enrollment-codes",
        payload: {},
      };
      expect((await app.inject(invalidPairing)).statusCode).toBe(201);
      expect((await app.inject(invalidPairing)).statusCode).toBe(429);

      const invalidUpload = {
        method: "POST" as const,
        url: "/api/chats/missing/attachments",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("test"),
      };
      expect((await app.inject(invalidUpload)).statusCode).toBe(404);
      expect((await app.inject(invalidUpload)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("does not apply the hosted API bucket to ordinary local traffic", async () => {
    const config = await testConfig({
      apiRateLimitPerMinute: 1,
      pairingRateLimitPerMinute: 1,
      uploadRateLimitPerMinute: 1,
    });
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      for (let request = 0; request < 3; request += 1) {
        expect(
          (await app.inject({ method: "GET", url: "/api/bootstrap" }))
            .statusCode,
        ).toBe(200);
      }

      const pairing = {
        method: "POST" as const,
        url: "/api/workers/enrollment-codes",
        payload: {},
      };
      expect((await app.inject(pairing)).statusCode).toBe(201);
      expect((await app.inject(pairing)).statusCode).toBe(429);

      const upload = {
        method: "POST" as const,
        url: "/api/chats/missing/attachments",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("test"),
      };
      expect((await app.inject(upload)).statusCode).toBe(404);
      expect((await app.inject(upload)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
