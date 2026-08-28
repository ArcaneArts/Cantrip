import { randomUUID } from "node:crypto";

import { remoteSurfaceAttachResultSchema } from "@cantrip/protocol";
import {
  workerLinkRemoteSurfaceGrantRequestSchema,
  workerLinkResourceGrantSchema,
} from "@cantrip/protocol/worker-link";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { WorkerLinkUnavailableError } from "../../worker-links/coordinator.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../../workers/bridge.js";

export interface WorkerLinkRemoteSurfaceGrantRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    "getRemoteSurfaceExecutionContext" | "getUserSettings"
  >;
  serverId: string;
  updateRemoteSurfaceStatus: (
    surfaceId: string,
    status: Parameters<ServerRepository["setRemoteSurfaceStatus"]>[1],
    error?: string | null,
  ) => ReturnType<ServerRepository["setRemoteSurfaceStatus"]>;
  workerLinks: Pick<
    WorkerLinkService,
    "issueGrant" | "revokeGrant" | "sessionForAuthorization"
  >;
}

/** Registers protected Browser and Remote Desktop grants over WorkerLink. */
export function installWorkerLinkRemoteSurfaceGrantRoute(
  app: FastifyInstance,
  {
    bridge,
    repository,
    serverId,
    updateRemoteSurfaceStatus,
    workerLinks,
  }: WorkerLinkRemoteSurfaceGrantRouteDependencies,
): void {
  app.post<{ Params: { sessionId: string; surfaceId: string } }>(
    "/api/worker-links/:sessionId/remote-surfaces/:surfaceId/grant",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkRemoteSurfaceGrantRequestSchema.safeParse(
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
      const context = await repository.getRemoteSurfaceExecutionContext(
        principal.user.id,
        request.params.surfaceId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Remote Surface not found." });
      }
      const surfaceName =
        context.surface.kind === "browser" ? "Browser" : "Remote Desktop";
      const resourceKind =
        context.surface.kind === "browser" ? "browser" : "remote-desktop";
      if (context.workerId !== session.identity.workerId) {
        return reply.code(409).send({
          error: `${surfaceName} placement does not match the WorkerLink session.`,
        });
      }
      if (!bridge.isConnected(context.workerId)) {
        await updateRemoteSurfaceStatus(
          context.surface.id,
          "offline",
          "Worker is offline.",
        );
        return reply.code(503).send({ error: "Worker is offline." });
      }

      const attachmentId = randomUUID();
      let attached = false;
      let grantId: string | null = null;
      try {
        await updateRemoteSurfaceStatus(context.surface.id, "connecting");
        const desktopStream =
          context.surface.kind === "desktop"
            ? await repository
                .getUserSettings(principal.user.id)
                .then((preferences) => ({
                  targetFps: preferences.desktopFrameRate,
                  quality: preferences.desktopStreamQuality,
                }))
            : null;
        remoteSurfaceAttachResultSchema.parse(
          await bridge.request(
            context.workerId,
            {
              type: "surface.attach",
              surfaceId: context.surface.id,
              attachmentId,
              projectId: context.surface.projectId,
              serverId,
              configuration: context.surface.configuration,
              stateResource:
                context.surface.kind === "browser"
                  ? context.surface.titleProtection.classification
                      .recordKind === "browser"
                    ? "browser-row"
                    : "browser-remote-surface"
                  : "remote-desktop-row",
              stateRevision: context.surface.stateRevision,
              stateProtection: context.surface.stateProtection,
              // WorkerLink owns direct negotiation. Do not start the legacy
              // feature-specific WebRTC attachment beneath this grant.
              preferredTransport: "websocket",
              webrtc: null,
              viewport: input.data.viewport,
              desktopStream,
            },
            { ownerId: principal.user.id, timeoutMs: 30_000 },
          ),
        );
        attached = true;
        const grant = await workerLinks.issueGrant({
          attachmentId,
          lanes: ["interactive", "realtime"],
          maxChannels: 2,
          operations: ["stream:open", "stream:read", "stream:write"],
          resourceId: context.surface.id,
          resourceKind,
          sessionId: session.sessionId,
        });
        grantId = grant.binding.grantId;
        const current = await repository.getRemoteSurfaceExecutionContext(
          principal.user.id,
          context.surface.id,
        );
        if (
          !current ||
          current.surface.kind !== context.surface.kind ||
          current.workerId !== context.workerId ||
          current.surface.stateRevision !== context.surface.stateRevision
        ) {
          await workerLinks.revokeGrant(
            session.sessionId,
            grant.binding.grantId,
            current ? "resource-stopped" : "resource-deleted",
          );
          attached = false;
          grantId = null;
          return reply.code(current ? 409 : 404).send({
            error: current
              ? `${surfaceName} placement or state changed while opening.`
              : `${surfaceName} surface not found.`,
          });
        }
        await updateRemoteSurfaceStatus(context.surface.id, "active");
        return reply.code(201).send(workerLinkResourceGrantSchema.parse(grant));
      } catch (error) {
        if (grantId) {
          await workerLinks
            .revokeGrant(session.sessionId, grantId, "resource-stopped")
            .catch(() => undefined);
          attached = false;
        }
        const message =
          error instanceof WorkerUnavailableError
            ? "Worker is offline."
            : `${surfaceName} surface could not be opened.`;
        await updateRemoteSurfaceStatus(
          context.surface.id,
          error instanceof WorkerUnavailableError ? "offline" : "error",
          message,
        );
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      } finally {
        if (attached && !grantId && bridge.isConnected(context.workerId)) {
          await bridge
            .request(
              context.workerId,
              {
                type: "surface.detach",
                surfaceId: context.surface.id,
                attachmentId,
              },
              { ownerId: principal.user.id, timeoutMs: 5_000 },
            )
            .catch(() => undefined);
        }
      }
    },
  );
}
