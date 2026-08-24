import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const origin = "https://usage.cantrip.test";
const password = "resource-usage-password";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected session cookie.");
  return cookie.split(";", 1)[0]!;
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-usage-api-"),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: "usage-bootstrap-token-with-at-least-32-characters",
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode: "accounts",
    authRateLimit: 100,
    bootstrapMode: "pnpm-dev",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "hosted",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    publicRegistration: true,
    secretEncryption: {
      activeKeyId: "usage-test",
      keys: [{ id: "usage-test", key: Buffer.alloc(32, 41) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "usage-test-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("account resource usage API", () => {
  it("returns only the authenticated account projection and bounded history", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });

    try {
      const firstRegistration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Usage First",
          email: "usage-first@example.com",
          password,
        },
      });
      const secondRegistration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Usage Second",
          email: "usage-second@example.com",
          password,
        },
      });
      expect(firstRegistration.statusCode).toBe(201);
      expect(secondRegistration.statusCode).toBe(201);
      const firstOwnerId = firstRegistration.json().currentUser.id as string;
      const secondOwnerId = secondRegistration.json().currentUser.id as string;
      const firstCookie = sessionCookie(firstRegistration);
      const secondCookie = sessionCookie(secondRegistration);

      const extraSession = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "usage-first@example.com", password },
      });
      expect(extraSession.statusCode).toBe(200);

      await database.repository.accountResourceUsage.reconcileStorage(
        "resource-usage-api-test",
        new Date("2026-08-23T10:15:00.000Z"),
      );
      const bandwidthBucket = new Date(
        Math.floor(Date.now() / 3_600_000) * 3_600_000,
      );
      await database.repository.accountResourceUsage.flushBandwidthBatch({
        meterId: "resource-usage-api-bandwidth",
        sequence: 1n,
        flushedAt: new Date(),
        entries: [
          {
            ownerId: firstOwnerId,
            bucketStart: bandwidthBucket,
            channel: "http",
            direction: "ingress",
            bytes: 100n,
            operationCount: 2n,
          },
          {
            ownerId: firstOwnerId,
            bucketStart: bandwidthBucket,
            channel: "client-live-websocket",
            direction: "egress",
            bytes: 40n,
            operationCount: 1n,
          },
          {
            ownerId: secondOwnerId,
            bucketStart: bandwidthBucket,
            channel: "http",
            direction: "ingress",
            bytes: 7n,
            operationCount: 1n,
          },
        ],
      });

      const firstRows =
        await database.repository.accountResourceUsage.listCurrentStorage(
          firstOwnerId,
        );
      const secondRows =
        await database.repository.accountResourceUsage.listCurrentStorage(
          secondOwnerId,
        );
      const serverTotal = (rows: typeof firstRows) =>
        rows
          .filter((row) => row.storageClass === "server")
          .reduce((total, row) => total + row.logicalBytes, 0n)
          .toString();

      const firstUsage = await app.inject({
        method: "GET",
        url: "/api/account/resource-usage",
        headers: { cookie: firstCookie, origin },
      });
      const secondUsage = await app.inject({
        method: "GET",
        url: "/api/account/resource-usage",
        headers: { cookie: secondCookie, origin },
      });
      expect(firstUsage.statusCode).toBe(200);
      expect(secondUsage.statusCode).toBe(200);
      expect(firstUsage.json().storage.server.logicalBytes).toBe(
        serverTotal(firstRows),
      );
      expect(secondUsage.json().storage.server.logicalBytes).toBe(
        serverTotal(secondRows),
      );
      expect(firstUsage.json().storage.server.logicalBytes).not.toBe(
        secondUsage.json().storage.server.logicalBytes,
      );
      expect(firstUsage.json()).toMatchObject({
        bandwidth: {
          accuracy: "metered",
          ingressBytes: "100",
          egressBytes: "40",
          operationCount: "3",
        },
        enforcement: "disabled",
        limits: null,
        measurement: {
          basisVersion: "postgres-logical-row-bytes-v1",
          status: "current",
        },
      });
      expect(secondUsage.json().bandwidth).toMatchObject({
        ingressBytes: "7",
        egressBytes: "0",
        operationCount: "1",
      });

      const history = await app.inject({
        method: "GET",
        url: "/api/account/resource-usage/history?metric=storage&resolution=hour&from=2026-08-23T10%3A00%3A00.000Z&to=2026-08-23T11%3A00%3A00.000Z",
        headers: { cookie: firstCookie, origin },
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({
        metric: "storage",
        resolution: "hour",
        status: "current",
        enforcement: "disabled",
        limits: null,
      });
      expect(history.json().series.length).toBeGreaterThan(0);

      const bandwidthHistory = await app.inject({
        method: "GET",
        url: `/api/account/resource-usage/history?metric=bandwidth&resolution=hour&from=${encodeURIComponent(bandwidthBucket.toISOString())}&to=${encodeURIComponent(new Date(bandwidthBucket.getTime() + 3_600_000).toISOString())}`,
        headers: { cookie: firstCookie, origin },
      });
      expect(bandwidthHistory.statusCode).toBe(200);
      expect(bandwidthHistory.json()).toMatchObject({
        metric: "bandwidth",
        resolution: "hour",
        status: "current",
        series: expect.arrayContaining([
          expect.objectContaining({
            channel: "http",
            direction: "ingress",
            points: [expect.objectContaining({ bytes: "100" })],
          }),
        ]),
      });

      const invalidHistory = await app.inject({
        method: "GET",
        url: "/api/account/resource-usage/history?metric=storage&resolution=hour&from=2026-01-01T00%3A00%3A00.000Z&to=2026-08-23T11%3A00%3A00.000Z",
        headers: { cookie: firstCookie, origin },
      });
      expect(invalidHistory.statusCode).toBe(400);

      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/account/resource-usage",
        headers: { origin },
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
