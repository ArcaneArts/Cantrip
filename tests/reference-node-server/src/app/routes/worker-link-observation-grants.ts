import { randomUUID } from "node:crypto";

import {
  workerLinkObservationGrantRequestSchema,
  workerLinkResourceGrantSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { WorkerLinkUnavailableError } from "../../worker-links/coordinator.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface WorkerLinkObservationGrantRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected">;
  repository: Pick<ServerRepository, "getWorker">;
  workerLinks: Pick<
    WorkerLinkService,
    "issueGrant" | "sessionForAuthorization"
  >;
}

/** Registers observation subscriptions over an authorized WorkerLink. */
export function installWorkerLinkObservationGrantRoute(
  app: FastifyInstance,
  {
    bridge,
    repository,
    workerLinks,
  }: WorkerLinkObservationGrantRouteDependencies,
): void {
  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/observations/grant",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkObservationGrantRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const accountSessionId =
        principal.sessionId ?? `local:${principal.user.id}`;
      const session = await workerLinks.sessionForAuthorization(
        request.params.sessionId,
        { accountSessionId, ownerId: principal.user.id },
      );
      if (!session) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      const worker = await repository.getWorker(
        principal.user.id,
        session.identity.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(session.identity.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      const subscriptionId = randomUUID();
      try {
        const grant = await workerLinks.issueGrant({
          attachmentId: subscriptionId,
          lanes: ["events"],
          maxChannels: 1,
          observation: {
            subscriptionId,
            topics: input.data.topics,
          },
          operations: ["events:subscribe"],
          resourceId: session.identity.workerId,
          resourceKind: "observations",
          sessionId: session.sessionId,
        });
        return reply.code(201).send(workerLinkResourceGrantSchema.parse(grant));
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
