import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthRateLimiter } from "../../auth/service.js";
import type { ServerConfig } from "../../config.js";

export interface AuthRouteSupportDependencies {
  authRateLimiter: AuthRateLimiter;
  config: Pick<ServerConfig, "appOrigins">;
}

/**
 * Owns the shared origin, abuse-limit, and registration-serialization helpers
 * used by the authentication route registrars.
 */
export function createAuthRouteSupport({
  authRateLimiter,
  config,
}: AuthRouteSupportDependencies) {
  const rejectUnapprovedAuthOrigin = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): unknown | null => {
    const origin = request.headers.origin;
    if (origin && !config.appOrigins.includes(origin)) {
      return reply.code(403).send({ error: "Origin is not allowed." });
    }
    return null;
  };

  const consumeAuthAttempt = (
    request: FastifyRequest,
    scope: string,
    identity: string,
    reply: FastifyReply,
  ): unknown | null => {
    const retryAfter = authRateLimiter.consume(
      `${scope}:${request.ip}:${identity}`,
    );
    if (retryAfter === null) return null;
    reply.header("retry-after", String(retryAfter));
    return reply
      .code(429)
      .send({ error: "Too many authentication attempts. Try again later." });
  };

  let registrationTail = Promise.resolve();
  const withRegistrationLock = async <T>(operation: () => Promise<T>) => {
    const predecessor = registrationTail;
    let release!: () => void;
    registrationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return {
    consumeAuthAttempt,
    rejectUnapprovedAuthOrigin,
    withRegistrationLock,
  };
}
