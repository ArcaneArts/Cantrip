import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const origin = "https://app.cantrip.test";
const bootstrapToken = "bootstrap-token-with-at-least-32-characters";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  if (typeof header !== "string") throw new Error("Expected a session cookie.");
  return header.split(";", 1)[0]!;
}

async function createConfig(
  authMode: "accounts" | "password",
): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), `cantrip-${authMode}-auth-`),
  );
  dataDirectories.push(dataDirectory);
  return {
    adminBootstrapToken: bootstrapToken,
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    allowInsecureRemote: false,
    appOrigins: [origin],
    authMode,
    authRateLimit: 20,
    bootstrapMode: "pnpm-dev",
    cookieSameSite: "none",
    cookieSecure: true,
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    passwordHash:
      authMode === "password" ? await hashPassword(password) : undefined,
    port: 4310,
    publicRegistration: false,
    sessionTtlSeconds: 3_600,
    workerToken: "auth-test-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("server account authentication", () => {
  it("bootstraps an owner, protects owner data, enforces CSRF, and revokes sessions", async () => {
    const config = await createConfig("accounts");
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });

    try {
      const bootstrap = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().auth).toEqual({
        mode: "accounts",
        state: "authentication-required",
        currentUser: null,
        registration: { enabled: true, bootstrapRequired: true },
      });
      expect(
        (await app.inject({ method: "GET", url: "/api/projects" })).statusCode,
      ).toBe(401);

      const denied = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": "incorrect" },
        payload: {
          displayName: "First Owner",
          email: "Owner@Example.com",
          password,
        },
      });
      expect(denied.statusCode).toBe(403);

      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": bootstrapToken },
        payload: {
          displayName: "First Owner",
          email: "Owner@Example.com",
          password,
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.json()).toMatchObject({
        currentUser: {
          email: "Owner@Example.com",
          kind: "account",
          role: "owner",
        },
      });
      expect(registered.headers["set-cookie"]).toContain(
        "__Host-cantrip_session=",
      );
      expect(registered.headers["set-cookie"]).toContain("HttpOnly");
      expect(registered.headers["set-cookie"]).toContain("SameSite=None");
      expect(registered.headers["set-cookie"]).toContain("Secure");
      const cookie = sessionCookie(registered);
      const csrfToken = registered.json().csrfToken as string;

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie, origin },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const authenticated = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { cookie, origin },
      });
      expect(authenticated.json().auth).toMatchObject({
        state: "authenticated",
        currentUser: { email: "Owner@Example.com", role: "owner" },
        registration: { enabled: false },
      });

      const loggedOut = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie, origin, "x-cantrip-csrf": csrfToken },
      });
      expect(loggedOut.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/projects",
            headers: { cookie, origin },
          })
        ).statusCode,
      ).toBe(401);

      const invalidLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "missing@example.com", password: "incorrect" },
      });
      expect(invalidLogin.statusCode).toBe(401);
      expect(invalidLogin.json()).toEqual({
        error: "Email or password is incorrect.",
      });

      const firstLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "owner@example.com", password },
      });
      const secondLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "OWNER@example.com", password },
      });
      expect(firstLogin.statusCode).toBe(200);
      expect(secondLogin.statusCode).toBe(200);
      const firstCookie = sessionCookie(firstLogin);
      const secondCookie = sessionCookie(secondLogin);

      const revoked = await app.inject({
        method: "POST",
        url: "/api/auth/logout-all",
        headers: {
          cookie: firstCookie,
          origin,
          "x-cantrip-csrf": firstLogin.json().csrfToken as string,
        },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().revokedSessions).toBeGreaterThanOrEqual(2);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/projects",
            headers: { cookie: secondCookie, origin },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("supports protected single-user password mode", async () => {
    const config = await createConfig("password");
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const signedIn = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().currentUser).toMatchObject({
        kind: "anonymous",
        role: "owner",
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/projects",
            headers: { cookie: sessionCookie(signedIn), origin },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);
});
