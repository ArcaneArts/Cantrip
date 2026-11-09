import {
  accountLiveTrafficQuerySchema,
  accountLiveTrafficSchema,
} from "@cantrip/protocol/resource-usage";
import type { FastifyInstance } from "fastify";

import type { LiveTrafficMeter } from "../../account-usage/live-traffic-meter.js";
import { principalOwnerId } from "../../auth/principal.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface AccountLiveTrafficRouteDependencies {
  liveTrafficMeter: Pick<LiveTrafficMeter, "snapshot">;
}

/** Returns bounded, process-local traffic history for the current account. */
export function installAccountLiveTrafficRoute(
  app: FastifyInstance,
  { liveTrafficMeter }: AccountLiveTrafficRouteDependencies,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/account/live-traffic",
    async (request, reply) => {
      const query = accountLiveTrafficQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send(invalidBody(query.error.issues));
      }
      return reply
        .header("cache-control", "private, no-store")
        .send(
          accountLiveTrafficSchema.parse(
            liveTrafficMeter.snapshot(principalOwnerId(request), query.data),
          ),
        );
    },
  );
}
