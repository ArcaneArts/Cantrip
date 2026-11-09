import {
  workerLinkTunnelGrantRequestSchema,
  workerLinkTunnelGrantSchema,
  tunnelOsPrepareResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import { isDeepStrictEqual } from "node:util";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import type {
  DesktopTunnelAttachmentLeaseChange,
  ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { WorkerLinkUnavailableError } from "../../worker-links/coordinator.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { TunnelManagementError } from "../../db/repository.js";

export interface WorkerLinkTunnelAttachmentGrantRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected"> &
    Partial<Pick<WorkerCommandBus, "request">>;
  directAttachments: Pick<
    DirectAttachmentCoordinator,
    | "acquirePreparationLease"
    | "bindPreparationLease"
    | "preparationLeaseIsActive"
    | "releasePreparationLease"
  >;
  publishTunnelRuntimeChange: (
    change: DesktopTunnelAttachmentLeaseChange,
  ) => void;
  repository: Pick<
    ServerRepository,
    "activateDesktopTunnelAttachment" | "getDesktopTunnelAttachment"
  > &
    Partial<Pick<ServerRepository, "tunnels">>;
  workerLinks: Pick<
    WorkerLinkService,
    "issueGrant" | "revokeGrant" | "sessionForAuthorization"
  >;
}

/** Registers protected tunnel attachment grants over WorkerLink. */
export function installWorkerLinkTunnelAttachmentGrantRoute(
  app: FastifyInstance,
  {
    bridge,
    directAttachments,
    publishTunnelRuntimeChange,
    repository,
    workerLinks,
  }: WorkerLinkTunnelAttachmentGrantRouteDependencies,
): void {
  app.post<{ Params: { sessionId: string; attachmentId: string } }>(
    "/api/worker-links/:sessionId/tunnel-attachments/:attachmentId/grant",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkTunnelGrantRequestSchema.safeParse(request.body);
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
      const preparationLease = directAttachments.acquirePreparationLease({
        attachmentId: request.params.attachmentId,
        authSessionId: accountSessionId,
        ownerId: principal.user.id,
        resourceId: null,
        resourceKind: "tunnel",
      });
      if (!preparationLease) {
        return reply.code(409).send({
          error: "The tunnel attachment is being revoked.",
        });
      }
      let grantId: string | null = null;
      try {
        const authorization = await repository.getDesktopTunnelAttachment(
          principal.user.id,
          request.params.attachmentId,
        );
        if (!authorization) {
          return reply
            .code(404)
            .send({ error: "Tunnel attachment not found." });
        }
        if (authorization.destination.workerId !== session.identity.workerId) {
          return reply.code(409).send({
            error: "Tunnel placement does not match the WorkerLink session.",
          });
        }
        if (!bridge.isConnected(authorization.destination.workerId)) {
          return reply
            .code(503)
            .send({ error: "Destination worker is offline." });
        }
        if (
          !directAttachments.bindPreparationLease(
            preparationLease,
            "tunnel",
            authorization.tunnelId,
          )
        ) {
          return reply.code(409).send({
            error: "The tunnel attachment changed while opening.",
          });
        }
        const listening = authorization.source?.kind === "worker-listener";
        const guest =
          listening ||
          (authorization.destination.kind === "worker-adapter" &&
            authorization.destination.adapter === "cantrip-os");
        const osExecution = guest
          ? await repository.tunnels?.resolveOsExecution(authorization)
          : undefined;
        if (guest && (!osExecution || !bridge.request || !repository.tunnels))
          throw new TunnelManagementError(
            "The captured OS tunnel is unavailable; no Host fallback was attempted.",
          );
        const grant = await workerLinks.issueGrant({
          absoluteExpiresAt: authorization.expiresAt.toISOString(),
          attachmentId: authorization.attachmentId,
          lanes: ["stream"],
          maxChannels: 1,
          operations: [
            "stream:open",
            "stream:read",
            "stream:write",
            "stream:half-close",
            ...(guest
              ? [
                  listening
                    ? ("stream:guest-listen" as const)
                    : ("stream:guest-connect" as const),
                ]
              : []),
          ],
          resourceId: authorization.tunnelId,
          resourceKind: "tunnel",
          sessionId: session.sessionId,
        });
        grantId = grant.binding.grantId;
        let serviceIdentity = authorization.osServiceIdentity;
        let ssh: import("@cantrip/protocol").WorkerLinkTunnelGrant["ssh"];
        if (osExecution) {
          const prepared = tunnelOsPrepareResultSchema.parse(
            await bridge.request!(
              authorization.destination.workerId,
              {
                type: "surface.tunnel.os-prepare",
                ...(listening ? { mode: "listen" as const } : {}),
                serverId: session.identity.serverId,
                projectId: authorization.projectId!,
                tunnelId: authorization.tunnelId,
                attachmentId: authorization.attachmentId,
                grantId: grant.binding.grantId,
                expiresAt: grant.binding.lease.absoluteExpiresAt,
                expectedIdentity: authorization.osServiceIdentity ?? null,
                protectedRecord: authorization.protectedRecord,
                osExecution,
              },
              { ownerId: principal.user.id, timeoutMs: 30_000 },
            ),
          );
          if (
            !(await repository.tunnels!.pinOsServiceIdentity(
              authorization,
              prepared.identity,
            ))
          )
            throw new TunnelManagementError(
              "The OS tunnel attachment was retired during preparation.",
            );
          serviceIdentity = prepared.identity;
          ssh = prepared.ssh;
        }
        const current = await repository.getDesktopTunnelAttachment(
          principal.user.id,
          request.params.attachmentId,
        );
        if (
          !current ||
          current.tunnelId !== authorization.tunnelId ||
          current.clientId !== authorization.clientId ||
          !isDeepStrictEqual(current.destination, authorization.destination) ||
          !isDeepStrictEqual(current.source, authorization.source) ||
          !isDeepStrictEqual(current.osSource, authorization.osSource) ||
          current.protectedRecord.revision !==
            authorization.protectedRecord.revision ||
          current.protectedRecord.operationId !==
            authorization.protectedRecord.operationId ||
          current.secretExpiresAt.getTime() !==
            authorization.secretExpiresAt.getTime() ||
          (guest &&
            (current.osServiceIdentity !== serviceIdentity ||
              !isDeepStrictEqual(
                await repository.tunnels!.resolveOsExecution(current),
                osExecution,
              ))) ||
          !directAttachments.preparationLeaseIsActive(preparationLease)
        ) {
          await workerLinks.revokeGrant(
            session.sessionId,
            grant.binding.grantId,
            current ? "resource-stopped" : "resource-deleted",
          );
          grantId = null;
          return reply.code(current ? 409 : 404).send({
            error: current
              ? "The tunnel attachment changed while opening."
              : "Tunnel attachment not found.",
          });
        }
        const activatedAt = await repository.activateDesktopTunnelAttachment(
          authorization.attachmentId,
          authorization.clientId,
          authorization.secretExpiresAt,
        );
        if (!activatedAt) {
          await workerLinks.revokeGrant(
            session.sessionId,
            grant.binding.grantId,
            "resource-stopped",
          );
          grantId = null;
          return reply
            .code(409)
            .send({ error: "The tunnel attachment could not be activated." });
        }
        const route = {
          tunnelId: authorization.tunnelId,
          attachmentId: authorization.attachmentId,
          sourceEndpointId: `worker-link-client:${grant.binding.grantId}`,
          destinationEndpointId: `worker-link-worker:${authorization.destination.workerId}`,
          target: {
            kind: "protected-tunnel" as const,
            targetKind:
              authorization.destination.kind === "worker-tcp" ||
              authorization.destination.adapter === "cantrip-os"
                ? ("tcp" as const)
                : authorization.destination.adapter === "project-share"
                  ? ("project-share" as const)
                  : ("code" as const),
            recordId: authorization.tunnelId,
            protectedRecord: authorization.protectedRecord,
          },
        };
        publishTunnelRuntimeChange({
          attachmentId: authorization.attachmentId,
          ownerId: authorization.ownerId,
          projectId: authorization.projectId,
          tunnelId: authorization.tunnelId,
        });
        return reply.code(201).send(
          workerLinkTunnelGrantSchema.parse({
            grant,
            route,
            ...(ssh ? { ssh } : {}),
          }),
        );
      } catch (error) {
        if (grantId) {
          await workerLinks
            .revokeGrant(session.sessionId, grantId, "resource-stopped")
            .catch(() => undefined);
        }
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof TunnelManagementError)
          return reply.code(409).send({ error: error.message });
        return sendWorkerRequestFailure(reply, error);
      } finally {
        directAttachments.releasePreparationLease(preparationLease);
      }
    },
  );
}
