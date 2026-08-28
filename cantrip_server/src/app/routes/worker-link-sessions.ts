import { directAttachmentTicketSchema } from "@cantrip/protocol";
import {
  workerLinkDirectActivationSchema,
  workerLinkGrantBindingSchema,
  workerLinkLeaseSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkPeerSessionOpenRequestSchema,
  workerLinkPeerSessionSchema,
  workerLinkPeerSignalBatchSchema,
  workerLinkRouteUpdateRequestSchema,
  workerLinkSessionOpenRequestSchema,
  workerLinkSessionSchema,
  workerLinkTelemetryBatchSchema,
} from "@cantrip/protocol/worker-link";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import {
  type DirectAttachmentCoordinator,
  DirectAttachmentUnavailableError,
} from "../../direct-attachments/coordinator.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { OperationalMetrics } from "../../operations/metrics.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import { WorkerLinkUnavailableError } from "../../worker-links/coordinator.js";
import type { WorkerLinkRelay } from "../../worker-links/relay.js";
import type { WorkerLinkService } from "../../worker-links/service.js";

interface SessionSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

export interface WorkerLinkSessionRouteDependencies {
  bridge: Pick<LimitedWorkerCommandBus, "isConnected">;
  config: Pick<ServerConfig, "appOrigins">;
  directAttachments: DirectAttachmentCoordinator;
  operationalMetrics: Pick<OperationalMetrics, "recordWorkerLinkTelemetry">;
  registerAuthenticatedSocket: (
    socket: SessionSocket,
    request: FastifyRequest,
  ) => boolean;
  registerSessionSocket: (
    socket: SessionSocket,
    request: FastifyRequest,
  ) => void;
  repository: Pick<ServerRepository, "getWorker">;
  workerLinkRelay: WorkerLinkRelay;
  workerLinks: WorkerLinkService;
}

/** Registers WorkerLink session lifecycle, peer, route, and relay endpoints. */
export function installWorkerLinkSessionRoutes(
  app: FastifyInstance,
  {
    bridge,
    config,
    directAttachments,
    operationalMetrics,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
    workerLinkRelay,
    workerLinks,
  }: WorkerLinkSessionRouteDependencies,
): void {
  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/worker-link/sessions",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkSessionOpenRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const worker = await repository.getWorker(
        principal.user.id,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!bridge.isConnected(worker.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const session = await workerLinks.openSession({
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          clientInstanceId: input.data.clientInstanceId,
          ownerId: principal.user.id,
          workerId: worker.workerId,
        });
        return reply.code(201).send(workerLinkSessionSchema.parse(session));
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/renew",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const authorization = {
        accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      if (
        !(await workerLinks.sessionForAuthorization(
          request.params.sessionId,
          authorization,
        ))
      ) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      try {
        return reply.send(
          workerLinkSessionSchema.parse(
            await workerLinks.renewSession(request.params.sessionId),
          ),
        );
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/route",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkRouteUpdateRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const authorization = {
        accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      if (
        !(await workerLinks.sessionForAuthorization(
          request.params.sessionId,
          authorization,
        ))
      ) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      try {
        const session = await workerLinks.replaceRoute(
          request.params.sessionId,
          input.data.preferredRoute,
        );
        if (session.preferredRoute === "relay") {
          await directAttachments.revokeResource(
            principal.user.id,
            "worker-link",
            session.sessionId,
          );
        }
        return reply.send(workerLinkSessionSchema.parse(session));
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/telemetry",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkTelemetryBatchSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const session = await workerLinks.sessionForAuthorization(
        request.params.sessionId,
        {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        },
      );
      if (!session) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      if (input.data.routeGeneration > session.routeGeneration) {
        return reply
          .code(409)
          .send({ error: "WorkerLink route generation is not current." });
      }
      operationalMetrics.recordWorkerLinkTelemetry(input.data.samples);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/peers",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkPeerSessionOpenRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const session = await workerLinks.sessionForAuthorization(
        request.params.sessionId,
        {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        },
      );
      if (!session) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      try {
        return reply
          .code(201)
          .send(
            workerLinkPeerSessionDescriptorSchema.parse(
              await workerLinks.openPeerSession(
                request.params.sessionId,
                input.data,
              ),
            ),
          );
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { sessionId: string; peerSessionId: string };
  }>(
    "/api/worker-links/:sessionId/peers/:peerSessionId/signals",
    { logLevel: "warn" },
    async (request, reply) => {
      const peerSessionId =
        workerLinkPeerSessionSchema.shape.peerSessionId.safeParse(
          request.params.peerSessionId,
        );
      if (!peerSessionId.success) {
        return reply.code(400).send({ error: "Invalid peer session ID." });
      }
      const input = workerLinkPeerSignalBatchSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      if (
        !(await workerLinks.sessionForAuthorization(request.params.sessionId, {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        }))
      ) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      if (
        input.data.signals.some(
          (signal, index) =>
            signal.sessionId !== request.params.sessionId ||
            signal.peerSessionId !== peerSessionId.data ||
            signal.sender !== "client" ||
            signal.route !== input.data.signals[0]!.route ||
            signal.routeGeneration !== input.data.signals[0]!.routeGeneration ||
            signal.signalSequence !==
              input.data.signals[0]!.signalSequence + index,
        )
      ) {
        return reply
          .code(400)
          .send({ error: "WorkerLink peer signal authority does not match." });
      }
      try {
        for (const signal of input.data.signals) {
          await workerLinks.signalPeer(request.params.sessionId, signal);
        }
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { sessionId: string; peerSessionId: string };
  }>(
    "/api/worker-links/:sessionId/peers/:peerSessionId/mailbox",
    { logLevel: "warn" },
    async (request, reply) => {
      const peerSessionId =
        workerLinkPeerSessionSchema.shape.peerSessionId.safeParse(
          request.params.peerSessionId,
        );
      if (!peerSessionId.success) {
        return reply.code(400).send({ error: "Invalid peer session ID." });
      }
      const input = workerLinkPeerMailboxReadRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      if (
        !(await workerLinks.sessionForAuthorization(request.params.sessionId, {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        }))
      ) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      try {
        return reply.send(
          workerLinkPeerMailboxSchema.parse(
            await workerLinks.readPeerMailbox(
              request.params.sessionId,
              peerSessionId.data,
              input.data,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.delete<{
    Params: { sessionId: string; peerSessionId: string };
  }>(
    "/api/worker-links/:sessionId/peers/:peerSessionId",
    { logLevel: "warn" },
    async (request, reply) => {
      const peerSessionId =
        workerLinkPeerSessionSchema.shape.peerSessionId.safeParse(
          request.params.peerSessionId,
        );
      if (!peerSessionId.success) {
        return reply.code(400).send({ error: "Invalid peer session ID." });
      }
      const principal = authenticatedPrincipal(request);
      if (
        !(await workerLinks.sessionForAuthorization(request.params.sessionId, {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        }))
      ) {
        return reply.code(204).send();
      }
      await workerLinks.revokePeerSession(
        request.params.sessionId,
        peerSessionId.data,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/direct",
    { logLevel: "warn" },
    async (request, reply) => {
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
      if (!session.routePolicy.enabled.includes("local")) {
        return reply
          .code(409)
          .send({ error: "WorkerLink LOCAL is not enabled." });
      }
      const preparationLease = directAttachments.acquirePreparationLease({
        authSessionId: accountSessionId,
        ownerId: principal.user.id,
        resourceId: session.sessionId,
        resourceKind: "worker-link",
      });
      if (!preparationLease) {
        return reply.code(409).send({ error: "WorkerLink route is changing." });
      }
      try {
        const worker = await repository.getWorker(
          principal.user.id,
          session.identity.workerId,
        );
        if (!worker) {
          return reply.code(404).send({ error: "Worker not found." });
        }
        const ticket = await directAttachments.prepare({
          attachmentId: session.sessionId,
          authSessionId: accountSessionId,
          channels: ["worker-link"],
          leaseExpiresAt: new Date(session.lease.expiresAt),
          maxLeaseExpiresAt: new Date(session.lease.absoluteExpiresAt),
          ownerId: principal.user.id,
          preparationLease,
          resourceId: session.sessionId,
          resourceKind: "worker-link",
          worker,
        });
        return reply.code(201).send(directAttachmentTicketSchema.parse(ticket));
      } catch (error) {
        if (error instanceof DirectAttachmentUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      } finally {
        directAttachments.releasePreparationLease(preparationLease);
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId/direct-activate",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkDirectActivationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const authSessionId = principal.sessionId ?? `local:${principal.user.id}`;
      const session = await workerLinks.sessionForAuthorization(
        request.params.sessionId,
        { accountSessionId: authSessionId, ownerId: principal.user.id },
      );
      if (!session) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      const authorization = {
        attachmentId: session.sessionId,
        authSessionId,
        ownerId: principal.user.id,
      };
      if (!directAttachments.matches(input.data.capabilityId, authorization)) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          authorization,
          "capability_mismatch",
        );
        return reply.code(404).send({ error: "Direct attachment not found." });
      }
      if (
        !directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          authorization,
          "completed",
        )
      ) {
        return reply
          .code(409)
          .send({ error: "Direct attachment changed while activating." });
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { sessionId: string; grantId: string } }>(
    "/api/worker-links/:sessionId/grants/:grantId",
    { logLevel: "warn" },
    async (request, reply) => {
      const grantId = workerLinkGrantBindingSchema.shape.grantId.safeParse(
        request.params.grantId,
      );
      if (!grantId.success) {
        return reply.code(400).send({ error: "Invalid WorkerLink grant ID." });
      }
      const principal = authenticatedPrincipal(request);
      const authorization = {
        accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      if (
        !(await workerLinks.sessionForAuthorization(
          request.params.sessionId,
          authorization,
        ))
      ) {
        return reply.code(204).send();
      }
      await workerLinks.revokeGrant(
        request.params.sessionId,
        grantId.data,
        "released",
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { sessionId: string; grantId: string } }>(
    "/api/worker-links/:sessionId/grants/:grantId/renew",
    { logLevel: "warn" },
    async (request, reply) => {
      const grantId = workerLinkGrantBindingSchema.shape.grantId.safeParse(
        request.params.grantId,
      );
      if (!grantId.success) {
        return reply.code(400).send({ error: "Invalid WorkerLink grant ID." });
      }
      const principal = authenticatedPrincipal(request);
      const authorization = {
        accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      if (
        !(await workerLinks.sessionForAuthorization(
          request.params.sessionId,
          authorization,
        ))
      ) {
        return reply.code(404).send({ error: "WorkerLink session not found." });
      }
      try {
        return reply.send(
          workerLinkLeaseSchema.parse(
            await workerLinks.renewGrant(
              request.params.sessionId,
              grantId.data,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/api/worker-links/:sessionId",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const authorization = {
        accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
        ownerId: principal.user.id,
      };
      if (
        !(await workerLinks.sessionForAuthorization(
          request.params.sessionId,
          authorization,
        ))
      ) {
        return reply.code(204).send();
      }
      await directAttachments.revokeResource(
        principal.user.id,
        "worker-link",
        request.params.sessionId,
      );
      await workerLinks.revokeSession(request.params.sessionId, "released");
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { clientInstanceId?: string };
  }>(
    "/api/worker-links/:sessionId/connect",
    { websocket: true },
    async (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      if (!registerAuthenticatedSocket(socket, request)) return;
      registerSessionSocket(socket, request);
      const principal = authenticatedPrincipal(request);
      const session = await workerLinks.sessionForAuthorization(
        request.params.sessionId,
        {
          accountSessionId: principal.sessionId ?? `local:${principal.user.id}`,
          ownerId: principal.user.id,
        },
      );
      if (
        !session ||
        request.query.clientInstanceId !== session.identity.clientInstanceId
      ) {
        socket.close(1008, "WorkerLink session is unavailable");
        return;
      }
      workerLinkRelay.attach(session, socket);
    },
  );
}
