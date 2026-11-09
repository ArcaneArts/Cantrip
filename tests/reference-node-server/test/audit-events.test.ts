import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const origin = "https://app.cantrip.test";
const password = "audit-password-that-must-never-be-recorded";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("Expected a session cookie.");
  return cookie.split(";", 1)[0]!;
}

async function createConfig(): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-audit-"));
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: "audit-bootstrap-token-with-at-least-32-characters",
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
      activeKeyId: "audit-test",
      keys: [{ id: "audit-test", key: Buffer.alloc(32, 11) }],
    },
    sessionTtlSeconds: 3_600,
    workerToken: "audit-test-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("hosted account audit visibility", () => {
  it("lists safe session activity and scopes audit events by account role", async () => {
    const config = await createConfig();
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });

    try {
      const ownerRegistration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Audit Owner",
          email: "audit-owner@example.com",
          password,
        },
      });
      const memberRegistration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Audit Member",
          email: "audit-member@example.com",
          password,
        },
      });
      expect(ownerRegistration.statusCode).toBe(201);
      expect(memberRegistration.statusCode).toBe(201);
      expect(ownerRegistration.json().currentUser.role).toBe("owner");
      expect(memberRegistration.json().currentUser.role).toBe("member");

      const ownerCookie = sessionCookie(ownerRegistration);
      const memberCookie = sessionCookie(memberRegistration);
      const failedMemberLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin, "user-agent": "audit-test-client" },
        payload: {
          email: "audit-member@example.com",
          password: "deliberately-incorrect-secret",
        },
      });
      expect(failedMemberLogin.statusCode).toBe(401);

      const sessions = await app.inject({
        method: "GET",
        url: "/api/account/sessions",
        headers: { cookie: memberCookie, origin },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json()).toEqual([
        expect.objectContaining({
          authMethod: "account-password",
          current: true,
          id: expect.any(String),
        }),
      ]);
      expect(JSON.stringify(sessions.json())).not.toMatch(
        /tokenHash|csrfTokenHash|ipAddressHash|userAgentHash/,
      );

      const ownerAudit = await app.inject({
        method: "GET",
        url: "/api/account/audit-events?limit=100",
        headers: { cookie: ownerCookie, origin },
      });
      const memberAudit = await app.inject({
        method: "GET",
        url: "/api/account/audit-events?limit=100",
        headers: { cookie: memberCookie, origin },
      });
      expect(ownerAudit.statusCode).toBe(200);
      expect(memberAudit.statusCode).toBe(200);
      expect(ownerAudit.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "auth.registration-succeeded",
            ownerId: ownerRegistration.json().currentUser.id,
          }),
        ]),
      );
      expect(memberAudit.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "auth.registration-succeeded",
            ownerId: memberRegistration.json().currentUser.id,
          }),
          expect.objectContaining({
            action: "auth.login-failed",
            ownerId: memberRegistration.json().currentUser.id,
            result: "denied",
          }),
        ]),
      );
      expect(
        ownerAudit
          .json()
          .items.every(
            (event: { ownerId: string }) =>
              event.ownerId === ownerRegistration.json().currentUser.id,
          ),
      ).toBe(true);
      expect(
        memberAudit
          .json()
          .items.every(
            (event: { ownerId: string }) =>
              event.ownerId === memberRegistration.json().currentUser.id,
          ),
      ).toBe(true);

      const memberAdminAudit = await app.inject({
        method: "GET",
        url: "/api/admin/audit-events",
        headers: { cookie: memberCookie, origin },
      });
      expect(memberAdminAudit.statusCode).toBe(403);

      const adminAudit = await app.inject({
        method: "GET",
        url: "/api/admin/audit-events?limit=100",
        headers: { cookie: ownerCookie, origin },
      });
      expect(adminAudit.statusCode).toBe(200);
      expect(
        new Set(
          adminAudit
            .json()
            .items.map((event: { ownerId: string | null }) => event.ownerId),
        ),
      ).toEqual(
        new Set([
          ownerRegistration.json().currentUser.id,
          memberRegistration.json().currentUser.id,
        ]),
      );

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/admin/audit-events?limit=1",
        headers: { cookie: ownerCookie, origin },
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().items).toHaveLength(1);
      expect(firstPage.json().nextCursor).toEqual(expect.any(Number));
      const secondPage = await app.inject({
        method: "GET",
        url: `/api/admin/audit-events?limit=1&before=${firstPage.json().nextCursor}`,
        headers: { cookie: ownerCookie, origin },
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().items[0].id).toBeLessThan(
        firstPage.json().items[0].id,
      );

      const serializedAudit = JSON.stringify(adminAudit.json());
      expect(serializedAudit).not.toContain(password);
      expect(serializedAudit).not.toContain("deliberately-incorrect-secret");
      expect(serializedAudit).not.toContain("audit-member@example.com");
      expect(serializedAudit).not.toContain("audit-owner@example.com");
    } finally {
      await app.close();
    }
  }, 30_000);
});
