import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  authenticatedPrincipal,
  AuthenticationRequiredError,
  installRequestPrincipal,
  principalOwnerId,
} from "../src/auth/principal.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("request principals", () => {
  it("attaches the anonymous local identity to every local request", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    installRequestPrincipal(app, {
      authMode: "none",
      localUser: {
        id: "local-user",
        kind: "anonymous",
        displayName: "Local User",
        email: null,
        role: "owner",
      },
    });
    app.get("/principal", async (request) => ({
      ownerId: principalOwnerId(request),
      principal: request.principal,
    }));

    const response = await app.inject({ method: "GET", url: "/principal" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ownerId: "local-user",
      principal: {
        authentication: "none",
        authMode: "none",
        kind: "anonymous",
        sessionId: null,
        state: "authenticated",
        user: {
          id: "local-user",
          kind: "anonymous",
          displayName: "Local User",
          email: null,
          role: "owner",
        },
      },
    });
  });

  it.each(["password", "accounts"] as const)(
    "fails closed when %s mode has not resolved a session",
    async (authMode) => {
      const app = Fastify({ logger: false });
      apps.push(app);
      installRequestPrincipal(app, { authMode });
      app.get("/principal", async (request) => {
        expect(() => authenticatedPrincipal(request)).toThrow(
          AuthenticationRequiredError,
        );
        return request.principal;
      });

      const response = await app.inject({
        method: "GET",
        url: "/principal",
      });
      expect(response.json()).toEqual({
        authentication: null,
        authMode,
        kind: "unauthenticated",
        sessionId: null,
        state: "authentication-required",
        user: null,
      });
    },
  );
});
