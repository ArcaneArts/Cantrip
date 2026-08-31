import type { FastifyInstance, FastifyRequest } from "fastify";

import { serverLogger } from "../../logger.js";
import {
  LEGACY_FEATURE_TRANSPORT_DEPRECATION,
  LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK,
  legacyFeatureTransportEndpoint,
} from "../../operations/legacy-feature-transports.js";
import { OperationalMetrics } from "../../operations/metrics.js";
import type { LiveTrafficMeter } from "../../account-usage/live-traffic-meter.js";

export function installOperationalHooks(
  app: FastifyInstance,
  liveTrafficMeter: Pick<LiveTrafficMeter, "recordHttpRequest">,
): OperationalMetrics {
  const operationalMetrics = new OperationalMetrics();
  const requestMetrics = new WeakMap<
    FastifyRequest,
    { release: () => void; startedAt: number }
  >();
  app.addHook("onRequest", (request, reply, done) => {
    requestMetrics.set(request, {
      release: operationalMetrics.beginHttpRequest(),
      startedAt: performance.now(),
    });
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    const legacyEndpoint = legacyFeatureTransportEndpoint(
      request.method,
      route,
    );
    if (legacyEndpoint) {
      reply.header("deprecation", LEGACY_FEATURE_TRANSPORT_DEPRECATION);
      reply.header("link", LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK);
      operationalMetrics.recordLegacyFeatureTransport(legacyEndpoint);
      serverLogger.rateLimited(
        `legacy-feature-transport:${legacyEndpoint}`,
        "warn",
        "Deprecated feature transport endpoint requested",
        {
          endpoint: legacyEndpoint,
          event: "network.compatibility-endpoint.requested",
          operation: "connect",
          reasonCode: "legacy-feature-transport",
          status: "deprecated",
          subsystem: "worker-link",
        },
      );
    }
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const metric = requestMetrics.get(request);
    if (metric) {
      metric.release();
      operationalMetrics.recordHttpResponse(
        request.method,
        reply.statusCode,
        metric.startedAt,
      );
      if (
        request.method !== "OPTIONS" &&
        request.headers.upgrade?.toLowerCase() !== "websocket" &&
        request.principal?.state === "authenticated"
      ) {
        const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
        liveTrafficMeter.recordHttpRequest(request.principal.user.id, route);
      }
      requestMetrics.delete(request);
    }
    done();
  });
  return operationalMetrics;
}
