import { randomUUID } from "node:crypto";

import {
  codeAttachmentCreateSchema,
  codeProbeResultSchema,
  codeProtectedAttachmentCreateSchema,
  codeProtectedAttachmentIntentSchema,
  codeProtectedAttachmentWireSchema,
  codeRuntimeStatusSchema,
  codeTabWireSummarySchema,
  worktreeSelectionSchema,
  type CodeRuntimeStatus,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { authenticatedPrincipal } from "../../auth/principal.js";
import { scopedCodeProfileId } from "../../chats/execution-helpers.js";
import type { CodeTunnelBroker } from "../../code/tunnel.js";
import type { ServerRepository } from "../../db/repository.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";

export interface CodeTabAttachmentRouteDependencies {
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  codeTunnel: CodeTunnelBroker;
  directAttachments: Pick<
    DirectAttachmentCoordinator,
    "revokeAttachment" | "revokeResource"
  >;
  repository: ServerRepository;
  requireProjectWorktrees: (projectId: string) => Promise<unknown>;
  serverId: string;
  updateCodeSessionRuntime: (
    ...input: Parameters<ServerRepository["updateCodeSessionRuntime"]>
  ) => ReturnType<ServerRepository["updateCodeSessionRuntime"]>;
}

export function installCodeTabWorktreeRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    directAttachments,
    repository,
    requireProjectWorktrees,
  }: Pick<
    CodeTabAttachmentRouteDependencies,
    | "applicationOwnerId"
    | "directAttachments"
    | "repository"
    | "requireProjectWorktrees"
  >,
): void {
  app.patch<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (context) await requireProjectWorktrees(context.codeTab.projectId);
      try {
        const previousSessions =
          (await repository.listCodeSessions(
            applicationOwnerId(),
            request.params.codeTabId,
          )) ?? [];
        const codeTab = await repository.updateCodeTabWorktree(
          applicationOwnerId(),
          request.params.codeTabId,
          input.data,
        );
        if (codeTab) {
          const sessionsAfterUpdate =
            (await repository.listCodeSessions(
              applicationOwnerId(),
              request.params.codeTabId,
            )) ?? [];
          const staleSessionIds = new Set([
            ...previousSessions.map(({ id }) => id),
            ...sessionsAfterUpdate.map(({ id }) => id),
          ]);
          await Promise.all(
            [...staleSessionIds].map((sessionId) =>
              directAttachments.revokeResource(
                applicationOwnerId(),
                "code",
                sessionId,
              ),
            ),
          );
        }
        return codeTab
          ? reply.send(codeTabWireSummarySchema.parse(codeTab))
          : reply.code(404).send({ error: "Code tab or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}

export function installCodeTabProtectedAttachmentRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    codeTunnel,
    directAttachments,
    repository,
    serverId,
    updateCodeSessionRuntime,
  }: Pick<
    CodeTabAttachmentRouteDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "codeTunnel"
    | "directAttachments"
    | "repository"
    | "serverId"
    | "updateCodeSessionRuntime"
  >,
): void {
  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/protected-attachment-intents",
    async (request, reply) => {
      const input = codeAttachmentCreateSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getCodeTabExecutionContext(
        ownerId,
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      if (
        input.data.expectedWorkerId !== context.workerId ||
        input.data.expectedWorktreeId !== context.worktreeId
      ) {
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      if (!context.capabilities.available) {
        return reply.code(409).send({
          error:
            context.capabilities.reason ??
            "Cantrip Code is unavailable on this worker.",
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
      const session = await repository.getOrCreateCodeSession(
        ownerId,
        request.params.codeTabId,
        probe.editorBuild,
        randomUUID(),
      );
      if (!session) {
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      const openingContext = await repository.getCodeTabExecutionContext(
        ownerId,
        request.params.codeTabId,
      );
      if (
        !openingContext ||
        openingContext.workerId !== context.workerId ||
        openingContext.worktreeId !== context.worktreeId ||
        openingContext.cwd !== context.cwd ||
        openingContext.codeTab.profileId !== context.codeTab.profileId ||
        session.workerId !== openingContext.workerId ||
        session.worktreeId !== openingContext.worktreeId ||
        session.profileId !== openingContext.codeTab.profileId
      ) {
        await directAttachments.revokeResource(ownerId, "code", session.id);
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      let runtime: CodeRuntimeStatus | null = null;
      try {
        runtime = codeRuntimeStatusSchema.parse(
          await bridge.request(openingContext.workerId, {
            type: "code.open",
            sessionId: session.id,
            codeTabId: openingContext.codeTab.id,
            projectId: openingContext.codeTab.projectId,
            worktreeId: openingContext.worktreeId,
            worktreeName: openingContext.worktreeName,
            cwd: openingContext.cwd,
            profileId: scopedCodeProfileId(
              ownerId,
              openingContext.codeTab.profileId,
            ),
            themeMode: "follow-cantrip",
            appearance: input.data.appearance,
            presentation: "workbench",
          }),
        );
        const freshContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          runtime.sessionId !== session.id ||
          !freshContext ||
          freshContext.workerId !== openingContext.workerId ||
          freshContext.worktreeId !== openingContext.worktreeId ||
          freshContext.cwd !== openingContext.cwd ||
          freshContext.codeTab.profileId !== openingContext.codeTab.profileId ||
          !(await updateCodeSessionRuntime(
            ownerId,
            openingContext.codeTab.id,
            session.id,
            runtime,
            true,
          ))
        ) {
          const rollbackStop =
            runtime.sessionId === session.id && runtime.sessionIncarnationId
              ? bridge
                  .request(
                    openingContext.workerId,
                    {
                      type: "code.stop",
                      sessionId: session.id,
                      expectedSessionIncarnationId:
                        runtime.sessionIncarnationId,
                    },
                    { timeoutMs: 5_000 },
                  )
                  .catch(() => undefined)
              : Promise.resolve();
          await Promise.all([
            rollbackStop,
            directAttachments.revokeResource(ownerId, "code", session.id),
          ]);
          return reply.code(409).send({
            error: "The Code tab changed while its editor was opening.",
          });
        }
      } catch (error) {
        const message = errorMessage(error);
        if (runtime?.sessionId === session.id && runtime.sessionIncarnationId) {
          void bridge
            .request(
              openingContext.workerId,
              {
                type: "code.stop",
                sessionId: session.id,
                expectedSessionIncarnationId: runtime.sessionIncarnationId,
              },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined);
        }
        const failedRuntime = codeRuntimeStatusSchema.parse({
          sessionId: session.id,
          status:
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          editorBuild: probe.editorBuild,
          processInstanceId: null,
          bridgeConnected: false,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: null,
          lastActivityAt: new Date().toISOString(),
          lastError: message,
        });
        await updateCodeSessionRuntime(
          ownerId,
          context.codeTab.id,
          session.id,
          failedRuntime,
        );
        return sendWorkerRequestFailure(reply, error, message);
      }
      if (!runtime) {
        return reply.code(502).send({ error: "Code editor did not start." });
      }
      return reply.code(201).send(
        codeProtectedAttachmentIntentSchema.parse({
          sessionId: session.id,
          runtime,
        }),
      );
    },
  );

  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/protected-attachments",
    async (request, reply) => {
      const input = codeProtectedAttachmentCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const authSessionId = authenticatedPrincipal(request).sessionId;
      const registrationLease = codeTunnel.acquireRegistrationLease({
        authSessionId,
        ownerId,
        sessionId: input.data.sessionId,
        tunnelId: input.data.tunnelId,
      });
      if (!registrationLease) {
        return reply.code(409).send({
          error: "The Code attachment lifecycle changed while attaching.",
        });
      }
      let registrationOwnership: "abort" | "binding" | "release" = "release";
      let registrationRuntime: CodeRuntimeStatus | null = null;
      let registrationWorkerId: string | null = null;
      let bindingAttachmentId: string | null = null;
      let retainBinding = false;
      try {
        const context = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Code tab not found." });
        }
        if (
          input.data.expectedWorkerId !== context.workerId ||
          input.data.expectedWorktreeId !== context.worktreeId
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const session = (
          (await repository.listCodeSessions(ownerId, context.codeTab.id)) ?? []
        ).find((candidate) => candidate.id === input.data.sessionId);
        if (
          !session ||
          input.data.expectedWorkerId !== session.workerId ||
          input.data.expectedWorktreeId !== session.worktreeId ||
          session.workerId !== context.workerId ||
          session.worktreeId !== context.worktreeId ||
          session.profileId !== context.codeTab.profileId
        ) {
          return reply
            .code(409)
            .send({ error: "Code session is unavailable." });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Worker is offline." });
        }
        let runtime: CodeRuntimeStatus;
        try {
          registrationOwnership = "abort";
          registrationWorkerId = context.workerId;
          runtime = codeRuntimeStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "code.status",
              sessionId: session.id,
            }),
          );
          registrationRuntime = runtime;
        } catch (error) {
          return sendWorkerRequestFailure(reply, error);
        }
        const freshContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          runtime.sessionId !== session.id ||
          !freshContext ||
          freshContext.workerId !== context.workerId ||
          freshContext.worktreeId !== context.worktreeId ||
          freshContext.cwd !== context.cwd ||
          freshContext.codeTab.profileId !== context.codeTab.profileId ||
          !codeTunnel.registrationLeaseIsActive(registrationLease)
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const createdAttachment = await codeTunnel.createProtectedAttachment({
          authSessionId,
          codeTabId: context.codeTab.id,
          ownerId,
          projectId: context.codeTab.projectId,
          protectedRecord: input.data.protectedRecord,
          runtime,
          serverId,
          sessionId: session.id,
          tunnelId: input.data.tunnelId,
          workerId: context.workerId,
          worktreeId: context.worktreeId,
          worktreePath: context.cwd,
          registrationLease,
        });
        bindingAttachmentId = createdAttachment.attachmentId;
        registrationOwnership = "binding";
        const attachment =
          codeProtectedAttachmentWireSchema.parse(createdAttachment);
        const attachedContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          !attachedContext ||
          attachedContext.workerId !== context.workerId ||
          attachedContext.worktreeId !== context.worktreeId ||
          attachedContext.cwd !== context.cwd ||
          attachedContext.codeTab.profileId !== context.codeTab.profileId ||
          !codeTunnel.attachmentRegistrationLeaseIsActive(
            attachment.attachmentId,
            registrationLease,
          )
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const response = reply.code(201).send(attachment);
        retainBinding = true;
        return response;
      } catch (error) {
        return reply
          .code(
            codeTunnel.registrationLeaseIsActive(registrationLease) ? 503 : 409,
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

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/code-attachments/:attachmentId",
    async (request, reply) => {
      await codeTunnel.revokeAttachment(
        request.params.attachmentId,
        applicationOwnerId(),
      );
      await directAttachments.revokeAttachment(request.params.attachmentId);
      return reply.code(204).send();
    },
  );
}

export function installCodeTabDeleteRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    codeTunnel,
    directAttachments,
    repository,
  }: Pick<
    CodeTabAttachmentRouteDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "codeTunnel"
    | "directAttachments"
    | "repository"
  >,
): void {
  app.delete<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId",
    async (request, reply) => {
      const sessions = await repository.listCodeSessions(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      const context = await repository.deleteCodeTab(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context || !sessions) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      await Promise.all(
        sessions.map((session) => codeTunnel.revokeSession(session.id)),
      );
      await Promise.all(
        sessions.map((session) =>
          directAttachments.revokeResource(
            applicationOwnerId(),
            "code",
            session.id,
          ),
        ),
      );
      if (bridge.isConnected(context.workerId)) {
        await Promise.allSettled(
          sessions
            .filter((session) => session.status !== "stopped")
            .map((session) =>
              bridge.request(context.workerId, {
                type: "code.stop",
                sessionId: session.id,
              }),
            ),
        );
      }
      return reply.code(204).send();
    },
  );
}
