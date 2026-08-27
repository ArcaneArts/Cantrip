import { isIP } from "node:net";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ServerConfig } from "../../config.js";
import { selectCantripWebSocketSubprotocol } from "../../workers/websocket-subprotocol.js";

function rejectSecurityRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 400 | 403,
  reason: string,
  message: string,
) {
  request.log.warn(
    {
      event: "security.request-rejected",
      method: request.method,
      reason,
      requestId: request.id,
      route: request.routeOptions.url ?? request.url.split("?", 1)[0],
    },
    "Rejected unsafe application request",
  );
  return reply.code(statusCode).send({ error: message });
}

export async function installTransportSecurity(
  app: FastifyInstance,
  config: ServerConfig,
  websocketMaxPayloadBytes: number,
): Promise<void> {
  const trustedProxyConfigured = Boolean(config.trustedProxies?.length);
  const expectedPublicHost = config.publicOrigin
    ? new URL(config.publicOrigin).host.toLowerCase()
    : null;

  app.addHook("onRequest", async (request, reply) => {
    const forwarded = request.headers.forwarded;
    const forwardedFor = request.headers["x-forwarded-for"];
    const forwardedHost = request.headers["x-forwarded-host"];
    const forwardedProto = request.headers["x-forwarded-proto"];
    const hasForwardedHeaders = Boolean(
      forwarded || forwardedFor || forwardedHost || forwardedProto,
    );
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    const directLoopbackProbe =
      (route === "/healthz" || route === "/readyz") &&
      !hasForwardedHeaders &&
      ["127.0.0.1", "::1"].includes(request.ip);
    if (directLoopbackProbe) return;
    if (hasForwardedHeaders && !trustedProxyConfigured) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "untrusted-forwarding-headers",
        "Forwarding headers require a configured trusted proxy.",
      );
    }
    if (forwarded) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "unsupported-forwarded-header",
        "Use validated X-Forwarded-* headers through the trusted proxy.",
      );
    }
    if (
      Array.isArray(forwardedFor) ||
      Array.isArray(forwardedHost) ||
      Array.isArray(forwardedProto)
    ) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "ambiguous-forwarding-headers",
        "Forwarding headers are invalid.",
      );
    }
    const forwardedLength = [forwardedFor, forwardedHost, forwardedProto]
      .filter((value): value is string => typeof value === "string")
      .reduce((total, value) => total + value.length, 0);
    if (forwardedLength > 2_048) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "oversized-forwarding-headers",
        "Forwarding headers are invalid.",
      );
    }
    if (typeof forwardedFor === "string") {
      const addresses = forwardedFor.split(",").map((value) => value.trim());
      if (
        addresses.length > 16 ||
        addresses.some((address) => isIP(address) === 0)
      ) {
        return rejectSecurityRequest(
          request,
          reply,
          400,
          "invalid-forwarded-for",
          "Forwarding headers are invalid.",
        );
      }
    }
    if (
      typeof forwardedProto === "string" &&
      !["http", "https"].includes(forwardedProto.toLowerCase())
    ) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "invalid-forwarded-proto",
        "Forwarding headers are invalid.",
      );
    }
    if (
      typeof forwardedHost === "string" &&
      (forwardedHost.includes(",") ||
        !/^[A-Za-z0-9.[\]:_-]{1,255}$/u.test(forwardedHost))
    ) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "invalid-forwarded-host",
        "Forwarding headers are invalid.",
      );
    }
    if (config.requireHttps && request.protocol !== "https") {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "insecure-public-scheme",
        "HTTPS is required.",
      );
    }
    if (
      expectedPublicHost &&
      request.host.toLowerCase() !== expectedPublicHost
    ) {
      return rejectSecurityRequest(
        request,
        reply,
        400,
        "unexpected-public-host",
        "Request host is not configured for this server.",
      );
    }
    const origin = request.headers.origin;
    const websocketUpgrade =
      request.headers.upgrade?.toLowerCase() === "websocket";
    if (origin && !websocketUpgrade && !config.appOrigins.includes(origin)) {
      return rejectSecurityRequest(
        request,
        reply,
        403,
        "unapproved-application-origin",
        "Origin is not allowed.",
      );
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("x-permitted-cross-domain-policies", "none");
    reply.header("x-request-id", request.id);
    if (!reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    if (config.requireHttps) {
      reply.header("strict-transport-security", "max-age=31536000");
    }
    return payload;
  });

  await app.register(cors, {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: config.appOrigins,
  });
  await app.register(websocket, {
    options: {
      handleProtocols: selectCantripWebSocketSubprotocol,
      maxPayload: websocketMaxPayloadBytes,
    },
  });
}
