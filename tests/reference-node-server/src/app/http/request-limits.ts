import type { FastifyInstance, FastifyRequest } from "fastify";

import { AuthRateLimiter } from "../../auth/service.js";
import type { ServerConfig } from "../../config.js";
import {
  ActiveLimit,
  SlidingWindowRateLimiter,
} from "../../security/abuse-limits.js";
import { MAX_PENDING_WORKER_HANDSHAKES } from "../shared/constants.js";

export interface RequestLimits {
  accountWebsockets: ActiveLimit;
  authRateLimiter: AuthRateLimiter;
  installHooks(app: FastifyInstance): void;
  pendingWorkerHandshakes: ActiveLimit;
}

export function createRequestLimits(config: ServerConfig): RequestLimits {
  const authRateLimiter = new AuthRateLimiter(config.authRateLimit ?? 10);
  const apiRateLimiter = new SlidingWindowRateLimiter(
    config.apiRateLimitPerMinute ?? 1_200,
  );
  const pairingRateLimiter = new SlidingWindowRateLimiter(
    config.pairingRateLimitPerMinute ?? 20,
  );
  const uploadRateLimiter = new SlidingWindowRateLimiter(
    config.uploadRateLimitPerMinute ?? 30,
  );
  const websocketRateLimiter = new SlidingWindowRateLimiter(
    config.websocketHandshakeRatePerMinute ?? 120,
  );
  const accountWebsockets = new ActiveLimit(config.accountWebsocketLimit ?? 32);
  const accountUploads = new ActiveLimit(config.accountUploadConcurrency ?? 4);
  const pendingWorkerHandshakes = new ActiveLimit(
    MAX_PENDING_WORKER_HANDSHAKES,
  );
  const uploadReleases = new WeakMap<FastifyRequest, () => void>();

  return {
    accountWebsockets,
    authRateLimiter,
    installHooks(app): void {
      app.addHook("onRequest", async (request, reply) => {
        if (request.method === "OPTIONS") return;
        const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
        const internalWorkerRoute =
          route.startsWith("/api/internal/workers/") &&
          route !== "/api/internal/workers/enroll";
        if (internalWorkerRoute) return;
        const key =
          request.principal.state === "authenticated"
            ? `owner:${request.principal.user.id}`
            : `ip:${request.ip}`;
        let limiter = apiRateLimiter;
        let category = "api";
        if (route === "/api/auth/login" || route === "/api/auth/register") {
          return;
        }
        if (
          (route === "/api/workers/enrollment-codes" &&
            request.method === "POST") ||
          route === "/api/internal/workers/enroll" ||
          route.endsWith("/credentials/rotate")
        ) {
          limiter = pairingRateLimiter;
          category = "pairing";
        } else if (
          route === "/api/chats/:chatId/attachments" &&
          request.method === "POST"
        ) {
          limiter = uploadRateLimiter;
          category = "upload";
        } else if (request.headers.upgrade?.toLowerCase() === "websocket") {
          limiter = websocketRateLimiter;
          category = "websocket-handshake";
        }
        if (category === "api" && config.deploymentMode === "local") return;
        const limiterKey =
          category === "api" ? `${key}:${request.method}:${route}` : key;
        const retryAfter = limiter.consume(limiterKey);
        if (retryAfter === null) {
          if (category === "upload") {
            const release = accountUploads.acquire(key);
            if (!release) {
              return reply
                .header("retry-after", "1")
                .code(429)
                .send({ error: "Account upload concurrency limit reached." });
            }
            uploadReleases.set(request, release);
          }
          return;
        }
        request.log.warn(
          {
            category,
            event: "security.rate-limited",
            requestId: request.id,
            route,
          },
          "Request rate limit reached",
        );
        const retryUnit = retryAfter === 1 ? "second" : "seconds";
        return reply
          .header("retry-after", String(retryAfter))
          .code(429)
          .send({
            code: `${category}-rate-limited`,
            error:
              category === "api"
                ? `Cantrip server request limit reached for this operation. Retry after ${retryAfter} ${retryUnit}.`
                : `Request rate limit reached. Retry after ${retryAfter} ${retryUnit}.`,
            retryAfterSeconds: retryAfter,
          });
      });

      app.addHook("onResponse", async (request) => {
        uploadReleases.get(request)?.();
        uploadReleases.delete(request);
      });
    },
    pendingWorkerHandshakes,
  };
}
