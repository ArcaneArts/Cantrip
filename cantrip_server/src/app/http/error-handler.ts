import type { FastifyInstance } from "fastify";

import { AuthenticationRequiredError } from "../../auth/principal.js";
import {
  ConflictingSessionCookiesError,
  type UserSessionService,
} from "../../auth/service.js";
import { ProjectCapabilityUnavailableError } from "../../projects/capabilities.js";
import { RelayLimitError } from "../../security/abuse-limits.js";

export function installApplicationErrorHandler(
  app: FastifyInstance,
  sessionService: UserSessionService,
): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConflictingSessionCookiesError) {
      sessionService.clear(reply);
      request.log.warn(
        {
          event: "security.session-cookie-conflict",
          requestId: request.id,
          route: request.routeOptions.url ?? request.url.split("?", 1)[0],
        },
        "Conflicting application session cookies were cleared",
      );
      return reply.code(401).send({
        code: "session-cookie-conflict",
        error: error.message,
      });
    }
    if (error instanceof AuthenticationRequiredError) {
      return reply.code(401).send({ error: error.message });
    }
    if (error instanceof RelayLimitError) {
      return reply
        .header("retry-after", String(error.retryAfterSeconds))
        .code(429)
        .send({ error: error.message });
    }
    if (error instanceof ProjectCapabilityUnavailableError) {
      return reply.code(error.statusCode).send(error.response());
    }
    const statusCode =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error(
        {
          err: error,
          event: "security.internal-error",
          requestId: request.id,
          route: request.routeOptions.url ?? request.url.split("?", 1)[0],
        },
        "Application request failed",
      );
      return reply.code(500).send({
        error: "Internal server error.",
        requestId: request.id,
      });
    }
    return reply.code(statusCode).send(error);
  });
}
