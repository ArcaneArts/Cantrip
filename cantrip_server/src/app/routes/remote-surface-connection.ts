import { randomUUID } from "node:crypto";

import {
  remoteSurfaceAttachResultSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceViewportSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { recordEncodedFrame } from "../../account-usage/frame-bandwidth.js";
import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import { principalOwnerId } from "../../auth/principal.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import type { RelayQuotaManager } from "../../operations/relay-quotas.js";
import type { RemoteSurfaceRelay } from "../../remote-surfaces/relay.js";
import { createRemoteSurfaceWebRtcConfiguration } from "../../remote-surfaces/webrtc.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

interface SessionSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

export interface RemoteSurfaceConnectionRouteDependencies {
  accountUsageMeter: AccountUsageMeter;
  bridge: LimitedWorkerCommandBus;
  config: Pick<ServerConfig, "appOrigins" | "remoteSurfaceWebRtc">;
  registerAuthenticatedSocket: (
    socket: SessionSocket,
    request: FastifyRequest,
  ) => boolean;
  registerSessionSocket: (
    socket: SessionSocket,
    request: FastifyRequest,
  ) => void;
  relayQuotas: RelayQuotaManager;
  repository: ServerRepository;
  serverId: string;
  surfaceAttachmentCounts: Map<string, number>;
  surfaceRelay: RemoteSurfaceRelay;
  updateRemoteSurfaceStatus: (
    surfaceId: string,
    status: Parameters<ServerRepository["setRemoteSurfaceStatus"]>[1],
    error?: string | null,
  ) => ReturnType<ServerRepository["setRemoteSurfaceStatus"]>;
}

export function installRemoteSurfaceConnectionRoute(
  app: FastifyInstance,
  {
    accountUsageMeter,
    bridge,
    config,
    registerAuthenticatedSocket,
    registerSessionSocket,
    relayQuotas,
    repository,
    serverId,
    surfaceAttachmentCounts,
    surfaceRelay,
    updateRemoteSurfaceStatus,
  }: RemoteSurfaceConnectionRouteDependencies,
): void {
  app.get<{
    Params: { surfaceId: string };
    Querystring: { width?: string; height?: string; devicePixelRatio?: string };
  }>(
    "/api/remote-surfaces/:surfaceId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      if (!registerAuthenticatedSocket(socket, request)) return;
      registerSessionSocket(socket, request);
      const ownerId = principalOwnerId(request);
      const viewport = remoteSurfaceViewportSchema.safeParse({
        width: Number(request.query.width ?? 1_280),
        height: Number(request.query.height ?? 720),
        devicePixelRatio: Number(request.query.devicePixelRatio ?? 1),
      });
      if (!viewport.success) {
        socket.close(1008, "Invalid viewport");
        return;
      }

      const attachmentId = randomUUID();
      let attached = false;
      let closed = false;
      let releaseSurfaceQuota: (() => void) | null = null;
      let surfaceId: string | null = null;
      let workerId: string | null = null;

      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          const encoded = JSON.stringify(
            remoteSurfaceConnectionMessageSchema.parse(message),
          );
          socket.send(encoded);
          recordEncodedFrame(accountUsageMeter, {
            ownerId,
            direction: "egress",
            channel: "remote-surface-relay",
            data: encoded,
          });
        }
      };

      socket.on("close", () => {
        closed = true;
        releaseSurfaceQuota?.();
        releaseSurfaceQuota = null;
        if (!attached || !surfaceId || !workerId) return;
        attached = false;
        const remaining = Math.max(
          0,
          (surfaceAttachmentCounts.get(surfaceId) ?? 1) - 1,
        );
        if (remaining === 0) surfaceAttachmentCounts.delete(surfaceId);
        else surfaceAttachmentCounts.set(surfaceId, remaining);
        if (bridge.isConnected(workerId)) {
          void bridge
            .request(workerId, {
              type: "surface.detach",
              surfaceId,
              attachmentId,
            })
            .catch(() => undefined);
        }
        if (remaining === 0) {
          void updateRemoteSurfaceStatus(
            surfaceId,
            bridge.isConnected(workerId) ? "idle" : "offline",
            bridge.isConnected(workerId) ? null : "Worker is offline.",
          );
        }
      });

      void (async () => {
        const context = await repository.getRemoteSurfaceExecutionContext(
          ownerId,
          request.params.surfaceId,
        );
        if (!context) {
          send({
            type: "error",
            message: "Remote Surface not found.",
            recoverable: false,
          });
          socket.close(1008, "Remote Surface not found");
          return;
        }
        surfaceId = context.surface.id;
        workerId = context.workerId;
        try {
          releaseSurfaceQuota = relayQuotas.acquireRemoteSurface(
            ownerId,
            workerId,
          );
        } catch (error) {
          send({
            type: "error",
            message: errorMessage(error),
            recoverable: true,
          });
          socket.close(1013, "Remote Surface quota reached");
          return;
        }
        if (closed) {
          releaseSurfaceQuota();
          releaseSurfaceQuota = null;
          return;
        }
        const desktopStream =
          context.surface.kind === "desktop"
            ? await repository.getUserSettings(ownerId).then((preferences) => ({
                targetFps: preferences.desktopFrameRate,
                quality: preferences.desktopStreamQuality,
              }))
            : null;
        if (!bridge.isConnected(workerId)) {
          await updateRemoteSurfaceStatus(
            surfaceId,
            "offline",
            "Worker is offline.",
          );
          send({
            type: "error",
            message: "Worker is offline.",
            recoverable: true,
          });
          socket.close(1013, "Worker offline");
          return;
        }

        await updateRemoteSurfaceStatus(surfaceId, "connecting");
        const webRtcConfiguration =
          context.surface.preferredTransport === "webrtc" &&
          context.remoteSurfaceCapabilities.transports.includes("webrtc") &&
          config.remoteSurfaceWebRtc &&
          context.remoteSurfaceCapabilities.iceTransportPolicies.includes(
            config.remoteSurfaceWebRtc.iceTransportPolicy,
          )
            ? createRemoteSurfaceWebRtcConfiguration(
                config.remoteSurfaceWebRtc,
                ownerId,
              )
            : null;
        const cleanupRelay = surfaceRelay.bind(socket, {
          surfaceId,
          attachmentId,
          ownerId,
          workerId,
        });
        try {
          const result = remoteSurfaceAttachResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "surface.attach",
                surfaceId,
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
                preferredTransport: context.surface.preferredTransport,
                webrtc: webRtcConfiguration,
                viewport: viewport.data,
                desktopStream,
              },
              { timeoutMs: 30_000 },
            ),
          );
          if (closed) {
            cleanupRelay();
            void bridge
              .request(workerId, {
                type: "surface.detach",
                surfaceId,
                attachmentId,
              })
              .catch(() => undefined);
            return;
          }
          attached = true;
          surfaceAttachmentCounts.set(
            surfaceId,
            (surfaceAttachmentCounts.get(surfaceId) ?? 0) + 1,
          );
          await updateRemoteSurfaceStatus(surfaceId, "active");
          send({
            type: "ready",
            surfaceId,
            attachmentId,
            transport: result.transport,
            webrtc: result.transport === "webrtc" ? webRtcConfiguration : null,
          });
        } catch (error) {
          cleanupRelay();
          const message =
            error instanceof WorkerUnavailableError
              ? "Worker is offline."
              : "Remote Surface could not be opened.";
          await updateRemoteSurfaceStatus(
            surfaceId,
            error instanceof WorkerUnavailableError ? "offline" : "error",
            message,
          );
          send({ type: "error", message, recoverable: true });
          socket.close(1013, "Remote Surface unavailable");
        }
      })();
    },
  );
}
