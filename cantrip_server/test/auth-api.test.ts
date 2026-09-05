import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
} from "../../packages/crypto/src/index.js";
import { cuaCursorPreferenceContext } from "@cantrip/protocol/computer-use-preferences";

import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/service.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";

const origin = "https://app.cantrip.test";
const bootstrapToken = "bootstrap-token-with-at-least-32-characters";
const password = "correct horse battery staple";
const dataDirectories: string[] = [];

function responseCookies(response: {
  headers: Record<string, unknown>;
}): string[] {
  const header = response.headers["set-cookie"];
  if (typeof header === "string") return [header];
  if (
    Array.isArray(header) &&
    header.every((value) => typeof value === "string")
  ) {
    return header;
  }
  throw new Error("Expected a session cookie.");
}

function sessionCookie(
  response: { headers: Record<string, unknown> },
  name = "__Host-cantrip_session",
): string {
  const cookie = responseCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  );
  if (!cookie) throw new Error(`Expected the ${name} cookie.`);
  return cookie.split(";", 1)[0]!;
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
  it("persists opaque cursor preferences only for the authenticated account and requires CSRF for changes", async () => {
    const config = await createConfig("accounts");
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": bootstrapToken },
        payload: {
          displayName: "Cursor Owner",
          email: "cursor@example.com",
          password,
        },
      });
      expect(registered.statusCode).toBe(201);
      const cookie = sessionCookie(registered);
      const ownerId = registered.json().currentUser.id as string;
      const headers = {
        cookie,
        origin,
        "x-cantrip-csrf": registered.json().csrfToken as string,
      };
      const content = {
        version: 1,
        style: "ring",
        color: "#FFFFFFFF",
        size: 32,
        label: "Private saved label",
        trail: true,
        visible: true,
      };
      const key = new Uint8Array(32).fill(41);
      const operationId = crypto.randomUUID();
      const context = {
        ...cuaCursorPreferenceContext(operationId),
        serverId: "preference-fixture-server",
      };
      const protectedContent = await encryptEndpointContentPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey: key,
        plaintext: new TextEncoder().encode(JSON.stringify(content)),
      });
      const record = { operationId, protectedContent };
      const payload = { protectedComputerUseCursor: record };
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/settings",
            headers: { cookie, origin },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/settings",
            headers,
            payload: { protectedComputerUseCursor: content },
          })
        ).statusCode,
      ).toBe(400);
      const saved = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers,
        payload,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(content.label);
      // A fresh authenticated request reads the persisted settings row.
      const loaded = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie, origin },
      });
      expect(loaded.statusCode).toBe(200);
      const stored = loaded.json().preferences.protectedComputerUseCursor;
      expect(stored).toEqual(record);
      expect(
        (await database.repository.getUserSettings(ownerId))
          .protectedComputerUseCursor,
      ).toEqual(record);
      const bytes = await decryptEndpointContentPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey: key,
        opaque: stored.protectedContent,
      });
      try {
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(content);
      } finally {
        bytes.fill(0);
        key.fill(0);
      }
      const other = await database.repository.createAccount({
        displayName: "Other",
        email: "cursor-other@example.com",
        normalizedEmail: "cursor-other@example.com",
        passwordHash: await hashPassword(password),
        role: "member",
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "cursor-other@example.com", password },
      });
      const otherSettings = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie: sessionCookie(login), origin },
      });
      expect(otherSettings.statusCode).toBe(200);
      expect(
        otherSettings.json().preferences.protectedComputerUseCursor,
      ).toBeNull();
      expect(
        (await database.repository.getUserSettings(other.id))
          .protectedComputerUseCursor,
      ).toBeNull();
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/settings",
            headers,
            payload: { theme: "dark" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await database.repository.getUserSettings(ownerId))
          .protectedComputerUseCursor,
      ).toEqual(record);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/settings",
            headers,
            payload: { protectedComputerUseCursor: null },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await database.repository.getUserSettings(ownerId))
          .protectedComputerUseCursor,
      ).toBeNull();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("fails closed when session cookies or the pinned account disagree", async () => {
    const config = await createConfig("accounts");
    const database = await connectDatabase(config);
    const app = await buildApp({ config, database, logger: false });
    try {
      const owner = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin, "x-cantrip-bootstrap-token": bootstrapToken },
        payload: {
          displayName: "First Owner",
          email: "owner@example.com",
          password,
        },
      });
      const member = await database.repository.createAccount({
        displayName: "Other Account",
        email: "other@example.com",
        normalizedEmail: "other@example.com",
        passwordHash: await hashPassword(password),
        role: "member",
      });
      const otherLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { email: "other@example.com", password },
      });
      expect(otherLogin.statusCode).toBe(200);

      const conflicting = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: {
          cookie: `${sessionCookie(owner)}; ${sessionCookie(
            otherLogin,
            "__Host-cantrip_partitioned_session",
          )}`,
          origin,
        },
      });
      expect(conflicting.statusCode).toBe(401);
      expect(conflicting.json()).toMatchObject({
        code: "session-cookie-conflict",
      });
      expect(responseCookies(conflicting)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("__Host-cantrip_session="),
          expect.stringContaining("__Host-cantrip_partitioned_session="),
        ]),
      );

      const mismatchedPin = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: {
          cookie: sessionCookie(owner),
          origin,
          "x-cantrip-account-id": member.id,
        },
      });
      expect(mismatchedPin.statusCode).toBe(401);
      expect(mismatchedPin.json()).toMatchObject({
        code: "session-account-mismatch",
      });
      expect(responseCookies(mismatchedPin)).toHaveLength(2);

      const matchingPair = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: {
          cookie: `${sessionCookie(owner)}; ${sessionCookie(
            owner,
            "__Host-cantrip_partitioned_session",
          )}`,
          origin,
          "x-cantrip-account-id": owner.json().currentUser.id as string,
        },
      });
      expect(matchingPair.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

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
      const cookies = responseCookies(registered);
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toContain("__Host-cantrip_session=");
      expect(cookies[0]).toContain("HttpOnly");
      expect(cookies[0]).toContain("SameSite=None");
      expect(cookies[0]).toContain("Secure");
      expect(cookies[0]).not.toContain("Partitioned");
      expect(cookies[1]).toContain("__Host-cantrip_partitioned_session=");
      expect(cookies[1]).toContain("HttpOnly");
      expect(cookies[1]).toContain("SameSite=None");
      expect(cookies[1]).toContain("Secure");
      expect(cookies[1]).toContain("Partitioned");
      const cookie = sessionCookie(registered);
      const partitionedCookie = sessionCookie(
        registered,
        "__Host-cantrip_partitioned_session",
      );
      const initialSettings = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { cookie, origin },
      });
      expect(initialSettings.statusCode).toBe(200);
      expect(initialSettings.json()).toMatchObject({
        preferences: { defaultModelId: null },
        providers: [],
        models: [],
      });
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
      expect(restoredSession.json().csrfToken).toBe(csrfToken);
      csrfToken = restoredSession.json().csrfToken as string;

      const restoredPartitionedSession = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: partitionedCookie, origin },
      });
      expect(restoredPartitionedSession.statusCode).toBe(200);
      expect(restoredPartitionedSession.json()).toMatchObject({
        currentUser: { email: "Owner@Example.com" },
        csrfToken,
      });
      csrfToken = restoredPartitionedSession.json().csrfToken as string;

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
      const mobileLiveSocket = await app.injectWS("/api/live", {
        headers: { cookie: mobileCookie, origin },
      });
      const mobileSessions = await app.inject({
        method: "GET",
        url: "/api/account/sessions",
        headers: { cookie: mobileCookie, origin },
      });
      expect(mobileSessions.statusCode).toBe(200);
      expect(mobileSessions.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authMethod: "mobile-qr",
            connected: true,
            current: true,
          }),
        ]),
      );
      const ownerSessions = await app.inject({
        method: "GET",
        url: "/api/account/sessions",
        headers: { cookie, origin },
      });
      expect(ownerSessions.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authMethod: "mobile-qr",
            connected: true,
            current: false,
          }),
        ]),
      );
      mobileLiveSocket.terminate();
      await vi.waitFor(async () => {
        const disconnectedSessions = await app.inject({
          method: "GET",
          url: "/api/account/sessions",
          headers: { cookie, origin },
        });
        expect(disconnectedSessions.json()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              authMethod: "mobile-qr",
              connected: false,
              current: false,
            }),
          ]),
        );
      });

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
      expect(responseCookies(loggedOut)).toEqual([
        expect.stringContaining("__Host-cantrip_session="),
        expect.stringContaining("__Host-cantrip_partitioned_session="),
      ]);
      expect(responseCookies(loggedOut)).toEqual([
        expect.stringContaining("Max-Age=0"),
        expect.stringContaining("Max-Age=0"),
      ]);
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
