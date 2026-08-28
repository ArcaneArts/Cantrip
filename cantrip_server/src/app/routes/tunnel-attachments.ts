import { randomBytes } from "node:crypto";

import {
  directTunnelPrepareRequestSchema,
  directTunnelTicketSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentCreateSchema,
  tunnelAttachmentInitializeSchema,
  tunnelAttachmentReadySchema,
  tunnelDirectActivationSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import {
  encodedFrameBytes,
  recordEncodedFrame,
} from "../../account-usage/frame-bandwidth.js";
import { authenticatedPrincipal } from "../../auth/principal.js";
import { hashSecret } from "../../auth/service.js";
import type {
  CodeAttachmentRootIdentity,
  CodeAttachmentRootLease,
  CodeAttachmentRootLeaseResult,
  CodeTunnelBroker,
} from "../../code/tunnel.js";
import type {
  ServerRepository,
  TunnelAttachmentAuthorization,
} from "../../db/repository.js";
import {
  type DirectAttachmentCoordinator,
  DirectAttachmentUnavailableError,
} from "../../direct-attachments/coordinator.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { TunnelRuntimeManager } from "../../tunnels/runtime.js";
import { tunnelBandwidthChannel } from "../../tunnels/runtime.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import {
  TUNNEL_ATTACHMENT_INITIALIZE_TIMEOUT_MS,
  TUNNEL_ATTACHMENT_LIFETIME_MS,
  TUNNEL_ATTACHMENT_SECRET_TTL_MS,
} from "../shared/constants.js";
import { tunnelAttachmentSocketSecret } from "../shared/request-policy.js";

interface AccountSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

type AttachmentAuthorization = Pick<
  TunnelAttachmentAuthorization,
  "destination" | "origin" | "ownerId" | "protectedRecord" | "tunnelId"
>;

export interface TunnelAttachmentRouteDependencies {
  accountUsageMeter: AccountUsageMeter;
  acquireAuthorizedCodeAttachmentRootLease: (
    authorization: AttachmentAuthorization,
    authSessionId: string | null,
  ) => CodeAttachmentRootLeaseResult;
  authorizedCodeAttachmentRootIdentity: (
    authorization: AttachmentAuthorization,
    authSessionId: string | null,
  ) => CodeAttachmentRootIdentity | null;
  codeTunnel: Pick<
    CodeTunnelBroker,
    | "allowRelayAttachmentActivity"
    | "bindRelayAttachment"
    | "releaseRelayAttachment"
    | "retiredSharedRelayAttachmentIsAuthorized"
  >;
  directAttachments: DirectAttachmentCoordinator;
  publishTunnelRuntimeChange: (change: {
    attachmentId: string;
    ownerId: string;
    projectId: string | null;
    tunnelId: string;
  }) => void;
  registerAccountSocket: (socket: AccountSocket, ownerId: string) => boolean;
  repository: Pick<
    ServerRepository,
    | "activateDesktopTunnelDirectLease"
    | "authorizeDesktopTunnelAttachment"
    | "createDesktopTunnelAttachment"
    | "finalizeDesktopTunnelDirectLease"
    | "getDesktopTunnelAttachment"
    | "getTunnel"
    | "getWorker"
  >;
  tunnelRuntime: Pick<
    TunnelRuntimeManager,
    "attach" | "closeActive" | "revoke"
  >;
  workerLinks: Pick<WorkerLinkService, "revokeAttachment">;
}

/** Registers tunnel attachment lifecycle, direct transport, and relay routes. */
export function installTunnelAttachmentRoutes(
  app: FastifyInstance,
  {
    accountUsageMeter,
    acquireAuthorizedCodeAttachmentRootLease,
    authorizedCodeAttachmentRootIdentity,
    codeTunnel,
    directAttachments,
    publishTunnelRuntimeChange,
    registerAccountSocket,
    repository,
    tunnelRuntime,
    workerLinks,
  }: TunnelAttachmentRouteDependencies,
): void {
  app.post<{ Params: { tunnelId: string } }>(
    "/api/tunnels/:tunnelId/attachments",
    async (request, reply) => {
      const input = tunnelAttachmentCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      const tunnel = await repository.getTunnel(
        ownerId,
        request.params.tunnelId,
      );
      if (!tunnel) {
        return reply.code(404).send({
          error: "An attachable desktop tunnel was not found.",
        });
      }
      let codeRootLease: CodeAttachmentRootLease | null = null;
      let codeRootIdentity: CodeAttachmentRootIdentity | null = null;
      if (tunnel.origin === "code") {
        if (!tunnel.protectedRecord) {
          return reply.code(409).send({
            error: "The protected Code attachment is unavailable.",
          });
        }
        const authorization = {
          destination: tunnel.destination,
          origin: tunnel.origin,
          ownerId,
          protectedRecord: tunnel.protectedRecord,
          tunnelId: tunnel.id,
        };
        const acquired = acquireAuthorizedCodeAttachmentRootLease(
          authorization,
          principal.sessionId,
        );
        if (!acquired.managed || !acquired.lease) {
          return reply.code(409).send({
            error: "The protected Code attachment has expired.",
          });
        }
        codeRootLease = acquired.lease;
        codeRootIdentity = authorizedCodeAttachmentRootIdentity(
          authorization,
          principal.sessionId,
        );
      }
      const secret = randomBytes(32).toString("base64url");
      const now = Date.now();
      const secretExpiresAt = new Date(now + TUNNEL_ATTACHMENT_SECRET_TTL_MS);
      const expiresAt = new Date(
        Math.min(
          now + TUNNEL_ATTACHMENT_LIFETIME_MS,
          codeRootLease
            ? Date.parse(codeRootLease.hardExpiresAt)
            : Number.POSITIVE_INFINITY,
        ),
      );
      const created = await repository.createDesktopTunnelAttachment(
        ownerId,
        request.params.tunnelId,
        {
          clientId: input.data.clientId,
          expiresAt,
          secretExpiresAt,
          secretHash: hashSecret(secret),
        },
      );
      if (!created) {
        return reply.code(404).send({
          error: "An attachable desktop tunnel was not found.",
        });
      }
      if (
        codeRootLease &&
        (!codeRootLease.validate() ||
          !codeRootIdentity ||
          !codeTunnel.bindRelayAttachment(
            created.attachmentId,
            codeRootIdentity,
          ))
      ) {
        const stopped = await tunnelRuntime.revoke(
          ownerId,
          created.attachmentId,
          {
            expected: {
              activatedAt: null,
              expiresAt: created.expiresAt,
              secretExpiresAt: created.secretExpiresAt,
            },
            preserveTunnelState: true,
          },
        );
        if (stopped) {
          codeTunnel.releaseRelayAttachment(created.attachmentId);
        }
        return reply.code(409).send({
          error: "The protected Code attachment changed while opening.",
        });
      }
      tunnelRuntime.closeActive(
        created.attachmentId,
        "Attachment credentials rotated",
        1008,
      );
      await workerLinks.revokeAttachment(
        ownerId,
        "tunnel",
        request.params.tunnelId,
        created.attachmentId,
      );
      publishTunnelRuntimeChange({
        attachmentId: created.attachmentId,
        ownerId,
        projectId: created.projectId,
        tunnelId: request.params.tunnelId,
      });
      return reply.code(201).send(
        tunnelAttachmentCreateResultSchema.parse({
          attachmentId: created.attachmentId,
          tunnelId: request.params.tunnelId,
          secret,
          connectPath: `/api/tunnel-attachments/${created.attachmentId}/connect`,
          secretExpiresAt: created.secretExpiresAt.toISOString(),
          expiresAt: created.expiresAt.toISOString(),
        }),
      );
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/tunnel-attachments/:attachmentId",
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      const authorization = await repository.getDesktopTunnelAttachment(
        ownerId,
        request.params.attachmentId,
      );
      const revoked = await directAttachments.mutateAttachment(
        request.params.attachmentId,
        async () => {
          if (authorization) {
            await workerLinks.revokeAttachment(
              ownerId,
              "tunnel",
              authorization.tunnelId,
              authorization.attachmentId,
            );
          }
          return tunnelRuntime.revoke(ownerId, request.params.attachmentId);
        },
      );
      if (!revoked) {
        if (
          codeTunnel.retiredSharedRelayAttachmentIsAuthorized(
            request.params.attachmentId,
            ownerId,
            principal.sessionId,
          )
        ) {
          return reply.code(204).send();
        }
        return reply.code(404).send({ error: "Tunnel attachment not found." });
      }
      codeTunnel.releaseRelayAttachment(request.params.attachmentId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { attachmentId: string } }>(
    "/api/tunnel-attachments/:attachmentId/lease",
    { logLevel: "warn" },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      const authorization = await repository.getDesktopTunnelAttachment(
        principal.user.id,
        request.params.attachmentId,
      );
      if (!authorization) {
        return reply.code(404).send({ error: "Tunnel attachment not found." });
      }
      const acquired = acquireAuthorizedCodeAttachmentRootLease(
        authorization,
        principal.sessionId,
      );
      if (acquired.managed && !acquired.lease) {
        return reply
          .code(409)
          .send({ error: "The protected Code attachment has expired." });
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { attachmentId: string }; Body: unknown }>(
    "/api/tunnel-attachments/:attachmentId/direct",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = directTunnelPrepareRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const authSessionId = principal.sessionId ?? `local:${principal.user.id}`;
      const preparationLease = directAttachments.acquirePreparationLease({
        attachmentId: request.params.attachmentId,
        authSessionId,
        ownerId: principal.user.id,
        resourceId: null,
        resourceKind: "tunnel",
      });
      if (!preparationLease) {
        return reply.code(409).send({
          error: "The owning resource is being revoked.",
        });
      }
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
        if (
          !directAttachments.bindPreparationLease(
            preparationLease,
            "tunnel",
            authorization.tunnelId,
          )
        ) {
          return reply.code(409).send({
            error:
              "The owning resource changed while direct access was opening.",
          });
        }
        const codeRoot = acquireAuthorizedCodeAttachmentRootLease(
          authorization,
          principal.sessionId,
        );
        if (codeRoot.managed && !codeRoot.lease) {
          return reply.code(409).send({
            error: "The protected Code attachment has expired.",
          });
        }
        const codeRootState = codeRoot.lease?.validate() ?? null;
        if (codeRoot.managed && !codeRootState) {
          return reply.code(409).send({
            error: "The protected Code attachment has expired.",
          });
        }
        const worker = await repository.getWorker(
          principal.user.id,
          authorization.destination.workerId,
        );
        if (!worker) {
          return reply
            .code(409)
            .send({ error: "Destination worker is offline." });
        }
        const route = {
          tunnelId: authorization.tunnelId,
          attachmentId: authorization.attachmentId,
          sourceEndpointId: `desktop:${authorization.clientId}:${authorization.attachmentId}`,
          destinationEndpointId: `worker:${authorization.destination.workerId}`,
        };
        const ticket = await directAttachments.prepare({
          attachmentId: authorization.attachmentId,
          ...(codeRoot.lease ? { authoritativeRoot: codeRoot.lease } : {}),
          authSessionId,
          channels: ["tunnel-data"],
          diagnosticTraceId: input.data.diagnosticTraceId,
          leaseExpiresAt: codeRootState
            ? new Date(
                Math.min(
                  authorization.expiresAt.getTime(),
                  Date.parse(codeRootState.expiresAt),
                ),
              )
            : authorization.expiresAt,
          maxLeaseExpiresAt: codeRootState
            ? new Date(
                Math.min(
                  authorization.expiresAt.getTime(),
                  Date.parse(codeRootState.hardExpiresAt),
                ),
              )
            : authorization.expiresAt,
          ownerId: principal.user.id,
          preparationLease,
          resourceId: authorization.tunnelId,
          resourceKind: "tunnel",
          tunnelRoute: {
            ...route,
            target: {
              kind: "protected-tunnel",
              targetKind:
                authorization.destination.kind === "worker-tcp"
                  ? "tcp"
                  : authorization.destination.adapter === "code"
                    ? "code"
                    : "project-share",
              recordId: authorization.tunnelId,
              protectedRecord: authorization.protectedRecord,
            },
          },
          worker,
        });
        const current = await repository.getDesktopTunnelAttachment(
          principal.user.id,
          request.params.attachmentId,
        );
        if (
          !current ||
          current.attachmentId !== authorization.attachmentId ||
          current.tunnelId !== authorization.tunnelId ||
          current.clientId !== authorization.clientId ||
          current.destination.workerId !== authorization.destination.workerId ||
          (codeRoot.lease && !codeRoot.lease.validate()) ||
          !directAttachments.preparationLeaseIsActive(preparationLease)
        ) {
          await directAttachments.revoke(
            ticket.binding.capabilityId,
            "Owning resource changed while direct access was opening",
          );
          return reply.code(current ? 409 : 404).send({
            error: current
              ? "The owning resource changed while direct access was opening."
              : "Tunnel attachment not found.",
          });
        }
        return reply
          .code(201)
          .send(directTunnelTicketSchema.parse({ ...ticket, route }));
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

  app.post<{ Params: { attachmentId: string } }>(
    "/api/tunnel-attachments/:attachmentId/direct-activate",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = tunnelDirectActivationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const authSessionId = principal.sessionId ?? `local:${principal.user.id}`;
      if (
        !directAttachments.matches(input.data.capabilityId, {
          attachmentId: request.params.attachmentId,
          authSessionId,
          ownerId: principal.user.id,
        })
      ) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: request.params.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "capability_mismatch",
        );
        return reply.code(404).send({ error: "Direct attachment not found." });
      }
      const authorization = await repository.getDesktopTunnelAttachment(
        principal.user.id,
        request.params.attachmentId,
      );
      if (!authorization) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: request.params.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "attachment_missing",
        );
        return reply.code(404).send({ error: "Tunnel attachment not found." });
      }
      const codeRoot = acquireAuthorizedCodeAttachmentRootLease(
        authorization,
        principal.sessionId,
      );
      if (codeRoot.managed && !codeRoot.lease) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: authorization.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "attachment_stale",
        );
        await directAttachments.revoke(
          input.data.capabilityId,
          "Protected Code attachment expired",
        );
        return reply
          .code(409)
          .send({ error: "The protected Code attachment has expired." });
      }
      const directLease = directAttachments.getTunnelLeaseForActivation(
        input.data.capabilityId,
        {
          attachmentId: authorization.attachmentId,
          authSessionId,
          ownerId: principal.user.id,
        },
      );
      if (!directLease) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: authorization.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "attachment_stale",
        );
        return reply.code(409).send({ error: "Tunnel attachment is stale." });
      }
      const activated = await repository.activateDesktopTunnelDirectLease(
        authorization.ownerId,
        authorization.attachmentId,
        input.data.capabilityId,
        new Date(directLease.leaseExpiresAt),
        authorization.secretExpiresAt,
      );
      if (!activated) {
        directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: authorization.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "attachment_stale",
        );
        return reply.code(409).send({ error: "Tunnel attachment is stale." });
      }
      if (
        !directAttachments.recordActivationOutcome(
          input.data.capabilityId,
          {
            attachmentId: authorization.attachmentId,
            authSessionId,
            ownerId: principal.user.id,
          },
          "completed",
        )
      ) {
        await repository.finalizeDesktopTunnelDirectLease(
          authorization.ownerId,
          authorization.attachmentId,
          input.data.capabilityId,
          new Date(directLease.leaseExpiresAt),
        );
        return reply
          .code(409)
          .send({ error: "Direct attachment changed while activating." });
      }
      publishTunnelRuntimeChange({
        attachmentId: authorization.attachmentId,
        ownerId: authorization.ownerId,
        projectId: authorization.projectId,
        tunnelId: authorization.tunnelId,
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { attachmentId: string } }>(
    "/api/tunnel-attachments/:attachmentId/connect",
    { websocket: true },
    async (socket, request) => {
      const initialized = new Promise<{ data: unknown; isBinary: boolean }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Tunnel initialization timed out.")),
            TUNNEL_ATTACHMENT_INITIALIZE_TIMEOUT_MS,
          );
          socket.once("message", (data, isBinary) => {
            clearTimeout(timer);
            resolve({ data, isBinary });
          });
          socket.once("close", () => {
            clearTimeout(timer);
            reject(new Error("Tunnel attachment disconnected."));
          });
        },
      );
      void initialized.catch(() => undefined);
      const secret = tunnelAttachmentSocketSecret(request.headers);
      if (secret.length < 32 || secret.length > 512) {
        socket.close(1008, "Attachment authentication failed");
        return;
      }
      const authorization = await repository.authorizeDesktopTunnelAttachment(
        request.params.attachmentId,
        hashSecret(secret),
      );
      if (!authorization) {
        socket.close(1008, "Attachment authentication failed");
        return;
      }
      if (
        authorization.origin === "code" &&
        !codeTunnel.allowRelayAttachmentActivity(
          authorization.attachmentId,
          authorization.tunnelId,
        )
      ) {
        socket.close(1008, "Protected attachment authority is unavailable");
        return;
      }
      if (!registerAccountSocket(socket, authorization.ownerId)) return;
      try {
        const initializedFrame = await initialized;
        const usageChannel = tunnelBandwidthChannel(authorization);
        accountUsageMeter.record({
          ownerId: authorization.ownerId,
          direction: "ingress",
          channel: usageChannel,
          bytes: encodedFrameBytes(initializedFrame.data),
        });
        if (initializedFrame.isBinary) {
          throw new Error("Tunnel initialization must be JSON.");
        }
        let initializedValue: unknown;
        try {
          initializedValue = JSON.parse(String(initializedFrame.data));
        } catch {
          throw new Error("Tunnel initialization is invalid.");
        }
        const initialize =
          tunnelAttachmentInitializeSchema.parse(initializedValue);
        const ready = await tunnelRuntime.attach(
          socket,
          authorization,
          initialize,
        );
        if (socket.readyState === 1) {
          const encoded = JSON.stringify(
            tunnelAttachmentReadySchema.parse(ready),
          );
          socket.send(encoded);
          recordEncodedFrame(accountUsageMeter, {
            ownerId: authorization.ownerId,
            direction: "egress",
            channel: usageChannel,
            data: encoded,
          });
        }
      } catch (error) {
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(1008, errorMessage(error));
        }
      }
    },
  );
}
