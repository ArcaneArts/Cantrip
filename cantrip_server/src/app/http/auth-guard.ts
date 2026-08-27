import type { FastifyInstance } from "fastify";

import type { UserSessionService } from "../../auth/service.js";
import type { ServerConfig } from "../../config.js";
import { serverLogger } from "../../logger.js";
import { csrfExemptRoute, publicRoute } from "../shared/request-policy.js";

export function installAuthenticationGuard(
  app: FastifyInstance,
  config: ServerConfig,
  sessionService: UserSessionService,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (config.authMode === "none" || request.method === "OPTIONS") return;
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (!publicRoute(route) && request.principal.state !== "authenticated") {
      serverLogger.rateLimited(
        `security-auth-required:${request.method}:${route}`,
        "warn",
        "Unauthenticated application request rejected",
        {
          event: "security.authentication.rejected",
          subsystem: "security",
          operation: request.method,
          reasonCode: "authentication-required",
          requestId: request.id,
          status: "rejected",
          route,
        },
      );
      return reply.code(401).send({ error: "Authentication is required." });
    }
    const expectedAccountId = request.headers["x-cantrip-account-id"];
    if (
      (!publicRoute(route) || route === "/api/auth/session") &&
      typeof expectedAccountId === "string" &&
      request.principal.state === "authenticated" &&
      request.principal.user.id !== expectedAccountId
    ) {
      sessionService.clear(reply);
      serverLogger.warn("Application session account pin did not match", {
        event: "security.session-account-mismatch",
        subsystem: "security",
        operation: request.method,
        reasonCode: "session-account-mismatch",
        requestId: request.id,
        status: "rejected",
        route,
      });
      return reply.code(401).send({
        code: "session-account-mismatch",
        error: "This server connection changed accounts. Sign in again.",
      });
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !csrfExemptRoute(route)
    ) {
      const origin = request.headers.origin;
      if (origin && !config.appOrigins.includes(origin)) {
        serverLogger.rateLimited(
          `security-origin-rejected:${request.method}:${route}`,
          "warn",
          "Application request origin rejected",
          {
            event: "security.origin.rejected",
            subsystem: "security",
            operation: request.method,
            reasonCode: "origin-not-allowed",
            requestId: request.id,
            status: "rejected",
            route,
          },
        );
        return reply.code(403).send({ error: "Origin is not allowed." });
      }
      const session = await sessionService.resolve(request);
      if (
        !session ||
        !sessionService.csrfMatches(session, request.headers["x-cantrip-csrf"])
      ) {
        serverLogger.rateLimited(
          `security-csrf-rejected:${request.method}:${route}`,
          "warn",
          "Application request failed CSRF validation",
          {
            event: "security.csrf.rejected",
            subsystem: "security",
            operation: request.method,
            reasonCode: "csrf-validation-failed",
            requestId: request.id,
            status: "rejected",
            route,
          },
        );
        return reply.code(403).send({ error: "CSRF validation failed." });
      }
    }
  });
}
