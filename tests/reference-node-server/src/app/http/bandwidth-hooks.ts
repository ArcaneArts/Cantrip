import type { FastifyInstance } from "fastify";

import type { AccountUsageRecorder } from "../../account-usage/bandwidth-meter.js";
import {
  encodedPayloadBytes,
  httpBandwidthChannelForRoute,
  isReadablePayload,
  meterPayloadStream,
} from "../../account-usage/http-bandwidth.js";
import { isAccountLiveTrafficRoute } from "../../account-usage/live-traffic-meter.js";

export function installBandwidthHooks(
  app: FastifyInstance,
  accountUsageMeter: AccountUsageRecorder,
): void {
  app.addHook("preParsing", async (request, _reply, payload) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (
      request.method === "OPTIONS" ||
      request.principal.state !== "authenticated" ||
      request.headers.upgrade?.toLowerCase() === "websocket" ||
      isAccountLiveTrafficRoute(route)
    ) {
      return payload;
    }
    return meterPayloadStream(
      payload,
      request.principal.user.id,
      "ingress",
      accountUsageMeter,
      !route.startsWith("/api/account/resource-usage"),
      httpBandwidthChannelForRoute(route),
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (
      request.method === "OPTIONS" ||
      request.principal?.state !== "authenticated" ||
      request.method === "HEAD" ||
      request.headers.upgrade?.toLowerCase() === "websocket" ||
      reply.statusCode === 204 ||
      reply.statusCode === 304 ||
      isAccountLiveTrafficRoute(route)
    ) {
      return payload;
    }
    const ownerId = request.principal.user.id;
    const notifyChange = !route.startsWith("/api/account/resource-usage");
    const channel = httpBandwidthChannelForRoute(route);
    const bytes = encodedPayloadBytes(payload);
    if (bytes !== null) {
      accountUsageMeter.record({
        ownerId,
        direction: "egress",
        channel,
        bytes,
        notifyChange,
      });
      return payload;
    }
    return isReadablePayload(payload)
      ? meterPayloadStream(
          payload,
          ownerId,
          "egress",
          accountUsageMeter,
          notifyChange,
          channel,
        )
      : payload;
  });
}
