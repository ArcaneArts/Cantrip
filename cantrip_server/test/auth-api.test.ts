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
      expect(bootstrap.headers["cache-control"]).toBe("no-store");
      expect(bootstrap.json().auth).toEqual({
        mode: "accounts",
        state: "authentication-required",
        currentUser: null,
        registration: {
          enabled: true,
          bootstrapRequired: true,
          licenseRequired: false,
        },
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
      let csrfToken = registered.json().csrfToken as string;

      const restoredSession = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie, origin },
      });
      expect(restoredSession.statusCode).toBe(200);
      expect(restoredSession.headers["cache-control"]).toBe("no-store");
      expect(restoredSession.headers["access-control-allow-origin"]).toBe(
        origin,
      );
      expect(restoredSession.headers["access-control-allow-credentials"]).toBe(
        "true",
      );
      expect(restoredSession.json()).toMatchObject({
        currentUser: { email: "Owner@Example.com" },
        expiresAt: expect.any(String),
      });
      expect(restoredSession.json().csrfToken).not.toBe(csrfToken);
      csrfToken = restoredSession.json().csrfToken as string;

      const mobileGrant = await app.inject({
        method: "POST",
        url: "/api/auth/mobile-sign-in/grants",
        headers: { cookie, origin, "x-cantrip-csrf": csrfToken },
        payload: {},
      });
      expect(mobileGrant.statusCode).toBe(201);
      expect(mobileGrant.headers["cache-control"]).toBe("no-store");
      expect(mobileGrant.json()).toMatchObject({
        code: expect.stringMatching(/^ctms_/u),
        expiresAt: expect.any(String),
      });

      const deniedMobileOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/mobile-sign-in/exchange",
        headers: { origin: "https://attacker.invalid" },
        payload: { code: mobileGrant.json().code },
      });
      expect(deniedMobileOrigin.statusCode).toBe(403);

      const mobileSession = await app.inject({
        method: "POST",
        url: "/api/auth/mobile-sign-in/exchange",
        headers: { origin },
        payload: { code: mobileGrant.json().code },
      });
      expect(mobileSession.statusCode).toBe(200);
      expect(mobileSession.json().currentUser).toMatchObject({
        email: "Owner@Example.com",
      });
      const mobileCookie = sessionCookie(mobileSession);
      const mobileSessions = await app.inject({
        method: "GET",
        url: "/api/account/sessions",
        headers: { cookie: mobileCookie, origin },
      });
      expect(mobileSessions.statusCode).toBe(200);
      expect(mobileSessions.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ authMethod: "mobile-qr", current: true }),
        ]),
      );

      const reusedMobileGrant = await app.inject({
        method: "POST",
        url: "/api/auth/mobile-sign-in/exchange",
        headers: { origin },
        payload: { code: mobileGrant.json().code },
      });
      expect(reusedMobileGrant.statusCode).toBe(401);

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

  it("licenses account registration through the configured administrator", async () => {
    const config = {
      ...(await createConfig("accounts")),
      adminEmail: "admin@example.com",
      licenseWhitelistEnabled: true,
    } satisfies ServerConfig;
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });

    try {
      const bootstrap = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
      });
      expect(bootstrap.json().auth).toMatchObject({
        registration: {
          enabled: true,
          bootstrapRequired: false,
          licenseRequired: true,
        },
      });

      const prematureMember = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Early Member",
          email: "member@example.com",
          password,
        },
      });
      expect(prematureMember.statusCode).toBe(403);
      expect(prematureMember.json().error).toMatch(/administrator.*first/i);

      const registeredAdmin = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Server Admin",
          email: "ADMIN@example.com",
          password,
        },
      });
      expect(registeredAdmin.statusCode).toBe(201);
      expect(registeredAdmin.json().currentUser).toMatchObject({
        email: "ADMIN@example.com",
        role: "owner",
      });
      const adminCookie = sessionCookie(registeredAdmin);
      const adminCsrf = registeredAdmin.json().csrfToken as string;

      const initialSummary = await app.inject({
        method: "GET",
        url: "/api/admin/accounts",
        headers: { cookie: adminCookie, origin },
      });
      expect(initialSummary.statusCode).toBe(200);
      expect(initialSummary.json()).toEqual({
        userCount: 1,
        licenseWhitelist: {
          enabled: true,
          adminEmail: "admin@example.com",
          entries: [],
        },
      });

      const licensed = await app.inject({
        method: "POST",
        url: "/api/admin/license-whitelist",
        headers: {
          cookie: adminCookie,
          origin,
          "x-cantrip-csrf": adminCsrf,
        },
        payload: { email: "Member@Example.com" },
      });
      expect(licensed.statusCode).toBe(201);
      expect(licensed.json()).toMatchObject({
        email: "Member@Example.com",
        registered: false,
      });

      const unlicensed = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Unlicensed",
          email: "unlicensed@example.com",
          password,
        },
      });
      expect(unlicensed.statusCode).toBe(403);
      expect(unlicensed.json().error).toMatch(/not licensed/i);

      const registeredMember = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin },
        payload: {
          displayName: "Licensed Member",
          email: "member@example.com",
          password,
        },
      });
      expect(registeredMember.statusCode).toBe(201);
      expect(registeredMember.json().currentUser).toMatchObject({
        role: "member",
      });
      const memberCookie = sessionCookie(registeredMember);

      const refreshedSummary = await app.inject({
        method: "GET",
        url: "/api/admin/accounts",
        headers: { cookie: adminCookie, origin },
      });
      expect(refreshedSummary.json()).toMatchObject({
        userCount: 2,
        licenseWhitelist: {
          entries: [
            {
              email: "Member@Example.com",
              registered: true,
            },
          ],
        },
      });

      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/admin/accounts",
            headers: { cookie: memberCookie, origin },
          })
        ).statusCode,
      ).toBe(403);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/admin/license-whitelist/${licensed.json().id as string}`,
        headers: {
          cookie: adminCookie,
          origin,
          "x-cantrip-csrf": adminCsrf,
        },
      });
      expect(removed.statusCode).toBe(204);
      const afterRemoval = await app.inject({
        method: "GET",
        url: "/api/admin/accounts",
        headers: { cookie: adminCookie, origin },
      });
      expect(afterRemoval.json()).toMatchObject({
        userCount: 2,
        licenseWhitelist: { entries: [] },
      });
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
