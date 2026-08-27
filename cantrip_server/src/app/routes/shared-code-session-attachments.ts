import {
  codeProbeResultSchema,
  codeRuntimeStatusSchema,
  codeSharedAttachmentWireSchema,
  explorerCodeSessionAttachmentCreateSchema,
  type CodeRuntimeStatus,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import { scopedCodeProfileId } from "../../chats/execution-helpers.js";
import {
  canonicalCodeAuthSessionId,
  SharedCodeTransportCapacityError,
} from "../../code/shared-transport.js";
import {
  ExplorerCodeAttachmentLeaseError,
  type CodeTunnelBroker,
} from "../../code/tunnel.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { validUuidPathParameter } from "../shared/request-policy.js";

export interface SharedCodeSessionAttachmentRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  codeTunnel: Pick<
    CodeTunnelBroker,
    | "abortRegistrationSession"
    | "acquireRegistrationLease"
    | "createSharedSessionAttachment"
    | "registrationLeaseIsActive"
    | "releaseRegistrationLease"
    | "renewSharedSessionAttachment"
    | "revokeSharedSessionAttachment"
    | "revokeSharedTransport"
  >;
  relayCoordinationEnabled: boolean;
  repository: Pick<ServerRepository, "getExplorerExecutionContext">;
  serverId: string;
}

/** Registers shared Code session attachment creation and lifecycle controls. */
export function installSharedCodeSessionAttachmentRoutes(
  app: FastifyInstance,
  {
    bridge,
    codeTunnel,
    relayCoordinationEnabled,
    repository,
    serverId,
  }: SharedCodeSessionAttachmentRouteDependencies,
): void {
  app.post<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/code-session-attachments",
    async (request, reply) => {
      const input = explorerCodeSessionAttachmentCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (relayCoordinationEnabled) {
        return reply.code(409).send({
          code: "shared-code-transport-requires-single-server",
          error:
            "Shared Cantrip Code transports are disabled while server relay coordination is active.",
        });
      }
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      const authSessionId = canonicalCodeAuthSessionId(
        ownerId,
        principal.sessionId,
      );
      const registrationLease = codeTunnel.acquireRegistrationLease({
        authSessionId,
        explorerId: request.params.explorerId,
        ownerId,
        sessionId: input.data.sessionId,
        tunnelId: input.data.attachmentId,
      });
      if (!registrationLease) {
        return reply.code(409).send({
          error: "The Explorer changed while its shared editor was opening.",
        });
      }
      let registrationOwnership: "abort" | "binding" | "release" = "release";
      let registrationRuntime: CodeRuntimeStatus | null = null;
      let registrationWorkerId: string | null = null;
      let retainBinding = false;
      try {
        const context = await repository.getExplorerExecutionContext(
          ownerId,
          request.params.explorerId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Explorer not found." });
        }
        if (
          input.data.expectedWorkerId !== context.workerId ||
          input.data.expectedWorktreeId !== context.worktreeId
        ) {
          return reply.code(409).send({
            error: "The Explorer changed while its shared editor was opening.",
          });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Worker is offline." });
        }
        let probe;
        try {
          probe = codeProbeResultSchema.parse(
            await bridge.request(context.workerId, { type: "code.probe" }),
          );
        } catch (error) {
          return reply.code(503).send({ error: errorMessage(error) });
        }
        if (!probe.capabilities.available || !probe.editorBuild) {
          return reply.code(409).send({
            error:
              probe.capabilities.reason ??
              "This worker has no compatible Cantrip Code build.",
          });
        }
        if (
          probe.capabilities.sharedTransportProtocolVersion !== 2 ||
          !probe.serverControlPlaneGeneration ||
          !probe.workerProcessGeneration
        ) {
          return reply.code(409).send({
            code: "shared-code-transport-unsupported",
            error:
              "This worker does not support shared Cantrip Code transports.",
          });
        }
        let runtime: CodeRuntimeStatus;
        try {
          registrationOwnership = "abort";
          registrationWorkerId = context.workerId;
          runtime = codeRuntimeStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "code.open",
              sessionId: input.data.sessionId,
              codeTabId: `explorer:${context.explorerId}:${input.data.sessionId}`,
              projectId: context.projectId,
              worktreeId: context.worktreeId,
              cwd: context.root,
              profileId: scopedCodeProfileId(ownerId, "default"),
              ...(input.data.path ? { initialFile: input.data.path } : {}),
              themeMode: "follow-cantrip",
              appearance: input.data.appearance,
              presentation: "editor",
            }),
          );
          registrationRuntime = runtime;
        } catch (error) {
          return sendWorkerRequestFailure(reply, error);
        }
        const freshContext = await repository.getExplorerExecutionContext(
          ownerId,
          request.params.explorerId,
        );
        if (
          runtime.sessionId !== input.data.sessionId ||
          !runtime.sessionIncarnationId ||
          !freshContext ||
          freshContext.projectId !== context.projectId ||
          freshContext.workerId !== context.workerId ||
          freshContext.worktreeId !== context.worktreeId ||
          freshContext.root !== context.root ||
          !codeTunnel.registrationLeaseIsActive(registrationLease)
        ) {
          return reply.code(409).send({
            error: "The Explorer changed while its shared editor was opening.",
          });
        }
        const attachment = await codeTunnel.createSharedSessionAttachment({
          appearance: input.data.appearance,
          attachmentId: input.data.attachmentId,
          authSessionId,
          codeTabId: `explorer:${context.explorerId}:${input.data.sessionId}`,
          explorerId: context.explorerId,
          ownerId,
          projectId: context.projectId,
          protectedKeyRevision:
            input.data.transport.protectedRecord.protectedContent.keyRevision,
          registrationLease,
          runtime,
          serverId,
          serverControlPlaneGeneration: probe.serverControlPlaneGeneration,
          sessionId: input.data.sessionId,
          stopSessionOnRelease: true,
          transport: input.data.transport,
          workerId: context.workerId,
          workerProcessGeneration: probe.workerProcessGeneration,
          worktreeId: context.worktreeId,
          worktreePath: context.root,
        });
        registrationOwnership = "binding";
        const attachedContext = await repository.getExplorerExecutionContext(
          ownerId,
          request.params.explorerId,
        );
        if (
          !attachedContext ||
          attachedContext.projectId !== context.projectId ||
          attachedContext.workerId !== context.workerId ||
          attachedContext.worktreeId !== context.worktreeId ||
          attachedContext.root !== context.root ||
          !codeTunnel.registrationLeaseIsActive(registrationLease)
        ) {
          return reply.code(409).send({
            error: "The Explorer changed while its shared editor was opening.",
          });
        }
        const response = reply
          .code(201)
          .send(codeSharedAttachmentWireSchema.parse(attachment));
        retainBinding = true;
        return response;
      } catch (error) {
        return reply
          .code(
            error instanceof SharedCodeTransportCapacityError
              ? 429
              : error instanceof ExplorerCodeAttachmentLeaseError
                ? 409
                : 503,
          )
          .send({ error: errorMessage(error) });
      } finally {
        if (registrationOwnership === "abort" && registrationWorkerId) {
          await codeTunnel.abortRegistrationSession({
            lease: registrationLease,
            runtime: registrationRuntime,
            workerId: registrationWorkerId,
          });
        } else {
          codeTunnel.releaseRegistrationLease(registrationLease);
          if (registrationOwnership === "binding" && !retainBinding) {
            await codeTunnel.revokeSharedSessionAttachment({
              attachmentId: input.data.attachmentId,
              authSessionId,
              ownerId,
            });
          }
        }
      }
    },
  );

  app.post<{ Params: { attachmentId: string } }>(
    "/api/code-session-attachments/:attachmentId/lease",
    async (request, reply) => {
      if (!validUuidPathParameter(request.params.attachmentId)) {
        return reply.code(400).send({ error: "Invalid attachment ID." });
      }
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      const attachment = await codeTunnel.renewSharedSessionAttachment({
        attachmentId: request.params.attachmentId,
        authSessionId: canonicalCodeAuthSessionId(ownerId, principal.sessionId),
        ownerId,
      });
      return attachment
        ? reply.send(codeSharedAttachmentWireSchema.parse(attachment))
        : reply.code(404).send({ error: "Code session attachment not found." });
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/code-session-attachments/:attachmentId",
    async (request, reply) => {
      if (!validUuidPathParameter(request.params.attachmentId)) {
        return reply.code(400).send({ error: "Invalid attachment ID." });
      }
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      let revoked: boolean;
      try {
        revoked = await codeTunnel.revokeSharedSessionAttachment({
          attachmentId: request.params.attachmentId,
          authSessionId: canonicalCodeAuthSessionId(
            ownerId,
            principal.sessionId,
          ),
          ownerId,
        });
      } catch (error) {
        if (error instanceof SharedCodeTransportCapacityError) {
          return reply.code(429).send({ error: error.message });
        }
        throw error;
      }
      return revoked
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Code session attachment not found." });
    },
  );

  app.delete<{ Params: { transportId: string } }>(
    "/api/code-transports/:transportId",
    async (request, reply) => {
      if (!validUuidPathParameter(request.params.transportId)) {
        return reply.code(400).send({ error: "Invalid transport ID." });
      }
      const principal = authenticatedPrincipal(request);
      const ownerId = principal.user.id;
      let revoked: boolean;
      try {
        revoked = await codeTunnel.revokeSharedTransport(
          ownerId,
          canonicalCodeAuthSessionId(ownerId, principal.sessionId),
          request.params.transportId,
        );
      } catch (error) {
        if (error instanceof SharedCodeTransportCapacityError) {
          return reply.code(429).send({ error: error.message });
        }
        throw error;
      }
      return revoked
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Code transport not found." });
    },
  );
}
