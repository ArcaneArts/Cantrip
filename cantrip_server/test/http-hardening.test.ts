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
      pairingRateLimitPerMinute: 1,
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
});
