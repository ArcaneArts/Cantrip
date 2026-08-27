import {
  codeProbeResultSchema,
  codeProtectedAttachmentWireSchema,
  codeRuntimeStatusSchema,
  explorerCodeProtectedAttachmentCreateSchema,
  type CodeRuntimeStatus,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import { scopedCodeProfileId } from "../../chats/execution-helpers.js";
import {
  ExplorerCodeAttachmentLeaseError,
  type CodeTunnelBroker,
} from "../../code/tunnel.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ExplorerProtectedCodeAttachmentRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  codeTunnel: Pick<
    CodeTunnelBroker,
    | "abortRegistrationSession"
    | "acquireRegistrationLease"
    | "attachmentRegistrationLeaseIsActive"
    | "createProtectedAttachment"
    | "releaseRegistrationLease"
    | "revokeAttachment"
  >;
  repository: Pick<ServerRepository, "getExplorerExecutionContext">;
  serverId: string;
}

/** Registers protected Cantrip Code attachment creation for Explorers. */
export function installExplorerProtectedCodeAttachmentRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    codeTunnel,
    repository,
    serverId,
  }: ExplorerProtectedCodeAttachmentRouteDependencies,
): void {
  app.post<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/protected-code-attachments",
    async (request, reply) => {
      const input = explorerCodeProtectedAttachmentCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const registrationLease = codeTunnel.acquireRegistrationLease({
        authSessionId: authenticatedPrincipal(request).sessionId,
        explorerId: request.params.explorerId,
        ownerId,
        sessionId: input.data.sessionId,
        tunnelId: input.data.tunnelId,
      });
      if (!registrationLease) {
        return reply.code(409).send({
          error: "The Explorer changed while its editor was opening.",
        });
      }
      let registrationOwnership: "abort" | "binding" | "release" = "release";
      let registrationRuntime: CodeRuntimeStatus | null = null;
      let registrationWorkerId: string | null = null;
      let bindingAttachmentId: string | null = null;
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
            error: "The Explorer changed while its editor was opening.",
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
        const sessionId = input.data.sessionId;
        const surfaceId = `explorer:${context.explorerId}:${sessionId}`;
        let runtime: CodeRuntimeStatus;
        try {
          registrationOwnership = "abort";
          registrationWorkerId = context.workerId;
          runtime = codeRuntimeStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "code.open",
              sessionId,
              codeTabId: surfaceId,
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
          runtime.sessionId !== sessionId ||
          !freshContext ||
          freshContext.projectId !== context.projectId ||
          freshContext.workerId !== context.workerId ||
          freshContext.worktreeId !== context.worktreeId ||
          freshContext.root !== context.root
        ) {
          return reply.code(409).send({
            error: "The Explorer changed while its editor was opening.",
          });
        }
        try {
          const createdAttachment = await codeTunnel.createProtectedAttachment({
            authSessionId: authenticatedPrincipal(request).sessionId,
            codeTabId: surfaceId,
            ownerId,
            projectId: context.projectId,
            protectedRecord: input.data.protectedRecord,
            runtime,
            serverId,
            sessionId,
            stopSessionOnRelease: true,
            tunnelId: input.data.tunnelId,
            workerId: context.workerId,
            worktreeId: context.worktreeId,
            worktreePath: context.root,
            registrationLease,
          });
          bindingAttachmentId = createdAttachment.attachmentId;
          registrationOwnership = "binding";
          const attachment =
            codeProtectedAttachmentWireSchema.parse(createdAttachment);
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
            !codeTunnel.attachmentRegistrationLeaseIsActive(
              attachment.attachmentId,
              registrationLease,
            )
          ) {
            return reply.code(409).send({
              error: "The Explorer changed while its editor was opening.",
            });
          }
          const response = reply.code(201).send(attachment);
          retainBinding = true;
          return response;
        } catch (error) {
          return reply
            .code(error instanceof ExplorerCodeAttachmentLeaseError ? 409 : 503)
            .send({ error: errorMessage(error) });
        }
      } finally {
        if (registrationOwnership === "abort" && registrationWorkerId) {
          await codeTunnel.abortRegistrationSession({
            lease: registrationLease,
            runtime: registrationRuntime,
            workerId: registrationWorkerId,
          });
        } else {
          codeTunnel.releaseRegistrationLease(registrationLease);
          if (
            registrationOwnership === "binding" &&
            !retainBinding &&
            bindingAttachmentId
          ) {
            await codeTunnel.revokeAttachment(bindingAttachmentId, ownerId);
          }
        }
      }
    },
  );
}
