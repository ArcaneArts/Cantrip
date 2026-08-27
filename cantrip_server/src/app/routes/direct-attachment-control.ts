import {
  directAttachmentTicketSchema,
  directTransportTelemetrySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import {
  type DirectAttachmentCoordinator,
  DirectAttachmentUnavailableError,
} from "../../direct-attachments/coordinator.js";
import type { OperationalMetrics } from "../../operations/metrics.js";

export interface DirectAttachmentControlRouteDependencies {
  directAttachments: DirectAttachmentCoordinator;
  operationalMetrics: Pick<OperationalMetrics, "recordDirectTransport">;
  repository: ServerRepository;
}

export function installDirectAttachmentControlRoutes(
  app: FastifyInstance,
  {
    directAttachments,
    operationalMetrics,
    repository,
  }: DirectAttachmentControlRouteDependencies,
): void {
  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/direct-probe",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const authSessionId = principal.sessionId ?? `local:${principal.user.id}`;
      const preparationLease = directAttachments.acquirePreparationLease({
        authSessionId,
        ownerId: principal.user.id,
        resourceId: request.params.workerId,
        resourceKind: "probe",
      });
      if (!preparationLease) {
        return reply.code(409).send({
          error: "The owning resource is being revoked.",
        });
      }
      try {
        const worker = await repository.getWorker(
          principal.user.id,
          request.params.workerId,
        );
        if (!worker) {
          return reply.code(404).send({ error: "Worker not found." });
        }
        const ticket = await directAttachments.prepare({
          authSessionId,
          channels: ["probe"],
          ownerId: principal.user.id,
          preparationLease,
          resourceId: request.params.workerId,
          resourceKind: "probe",
          worker,
        });
        if (!directAttachments.preparationLeaseIsActive(preparationLease)) {
          await directAttachments.revoke(
            ticket.binding.capabilityId,
            "Owning resource was revoked",
          );
          return reply.code(409).send({
            error:
              "The owning resource changed while direct access was opening.",
          });
        }
        return reply.code(201).send(directAttachmentTicketSchema.parse(ticket));
      } catch (error) {
        if (error instanceof DirectAttachmentUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      } finally {
        directAttachments.releasePreparationLease(preparationLease);
      }
    },
  );

  app.delete<{ Params: { capabilityId: string } }>(
    "/api/direct-attachments/:capabilityId",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      await directAttachments.revoke(
        request.params.capabilityId,
        "Client released direct attachment",
        {
          authSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        },
      );
      // A completed or concurrent revocation is already the requested end state.
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { capabilityId: string } }>(
    "/api/direct-attachments/:capabilityId/telemetry",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const telemetry = directTransportTelemetrySchema.parse(request.body);
      const authorization = {
        authSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      const activeDelta = directAttachments.recordTelemetry(
        request.params.capabilityId,
        authorization,
        telemetry,
      );
      const delta =
        activeDelta ??
        directAttachments.recordFinalizedTelemetry(
          request.params.capabilityId,
          authorization,
          telemetry,
        );
      if (!delta) {
        return reply.code(404).send({ error: "Direct attachment not found." });
      }
      operationalMetrics.recordDirectTransport(delta.resourceKind, delta);
      if (activeDelta === null) return reply.code(204).send();
      const renewal = await directAttachments.renewActiveLease(
        request.params.capabilityId,
        authorization,
      );
      switch (renewal.status) {
        case "completed":
        case "unsupported":
          return reply.code(204).send();
        case "retryable-failure":
          return reply.code(503).send({
            error: "Direct attachment renewal is temporarily unavailable.",
          });
        case "missing":
          // Telemetry was correlated while the capability was live. A
          // concurrent authoritative teardown may have finalized it before
          // renewal; the requested terminal accounting still succeeded.
          return reply.code(204).send();
        case "expired":
        case "not-active":
        case "root-missing":
        case "worker-rejected":
          return reply.code(409).send({
            error: "Direct attachment renewal was rejected.",
          });
      }
    },
  );
}
