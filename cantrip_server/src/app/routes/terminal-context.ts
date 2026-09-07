import {
  encryptedLinkedConsoleCreateSchema,
  protectedScriptCommandListSchema,
  terminalWireSummarySchema,
  worktreeSelectionSchema,
} from "@cantrip/protocol";
import { endpointContentContextSchema } from "@cantrip/protocol/endpoint-content";
import { repositoryOperationOpaqueSchema } from "@cantrip/protocol/repository-operation";
import type { FastifyInstance, FastifyReply } from "fastify";

import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type { DirectAttachmentCoordinator } from "../../direct-attachments/coordinator.js";
import {
  ExecutionLaneConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "../../http/worker-request-failures.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { ExecutionOperationContext } from "../runtime/run-configuration-runtime.js";
import type { createModelRoutingRuntime } from "../runtime/model-routing-runtime.js";

type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;
type ApiFailureResponder = (reply: FastifyReply, error: unknown) => unknown;

export interface TerminalContextRouteDependencies extends Pick<
  ModelRoutingRuntime,
  "resolveModelId" | "runtimeCanResumeContext" | "runtimeForContext"
> {
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  directAttachments: Pick<DirectAttachmentCoordinator, "mutateResource">;
  repository: ServerRepository;
  requireProjectWorktrees: (projectId: string) => Promise<unknown>;
  resolveAppRunContext: (
    projectId: string,
    requestedWorktreeId?: string,
  ) => Promise<ExecutionOperationContext>;
  sendRunApiFailure: ApiFailureResponder;
  serverId: string;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
}

export function installChatLinkedConsoleRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    resolveModelId,
    runtimeCanResumeContext,
    runtimeForContext,
  }: Pick<
    TerminalContextRouteDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "repository"
    | "resolveModelId"
    | "runtimeCanResumeContext"
    | "runtimeForContext"
  >,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/console",
    async (request, reply) => {
      const input = encryptedLinkedConsoleCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      let context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Encrypted Task console state stays on its authorized worker.",
        });
      }
      const modelId = await resolveModelId(context);
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply
          .code(409)
          .send({ error: "No provider route is currently available." });
      }
      if (!context.threadId || !runtimeCanResumeContext(context, runtime)) {
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Project worker is offline." });
        }
        try {
          const mcpServers = await repository.listEffectiveMcpServers(
            applicationOwnerId(),
            context.projectId,
            context.workerId,
          );
          const result = (await bridge.request(context.workerId, {
            type: "chat.thread.ensure",
            cwd: context.cwd,
            threadId: null,
            planMode: context.planMode,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
            mcpServers,
          })) as { threadId?: unknown };
          if (typeof result.threadId !== "string" || !result.threadId) {
            throw new Error("Codex did not return a console thread.");
          }
          await repository.setChatModel(applicationOwnerId(), context.chatId, {
            modelId,
          });
          await repository.updateChatRuntime(
            context.chatId,
            context.workerId,
            context.worktreeId,
            result.threadId,
            runtime.routeId,
            "ready",
            runtime.provider.accountId,
          );
          const updated = await repository.getChatExecutionContext(
            applicationOwnerId(),
            context.chatId,
          );
          if (!updated) throw new Error("Chat source not found.");
          context = updated;
        } catch (error) {
          return sendWorkerConflictFailure(reply, error);
        }
      }
      const terminal = await repository.getOrCreateChatConsole(
        applicationOwnerId(),
        context.chatId,
        input.data,
      );
      return terminal
        ? reply.code(201).send(terminalWireSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Chat source not found." });
    },
  );
}

export function installProtectedScriptCommandRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    resolveAppRunContext,
    sendRunApiFailure,
    serverId,
  }: Pick<
    TerminalContextRouteDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "repository"
    | "resolveAppRunContext"
    | "sendRunApiFailure"
    | "serverId"
  >,
): void {
  app.get<{
    Params: { terminalId: string };
    Querystring: { operationId?: string };
  }>("/api/terminals/:terminalId/script-commands", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    const context = await repository.getTerminalExecutionContext(
      applicationOwnerId(),
      request.params.terminalId,
    );
    if (!context) {
      return reply.code(404).send({ error: "Terminal not found." });
    }
    if (context.kind === "run-configuration" || !context.stateProtection) {
      return reply.code(409).send({
        error:
          "Run configuration terminals do not expose interactive terminal commands.",
      });
    }
    if (!bridge.isConnected(context.workerId)) {
      return reply.code(503).send({ error: "Project worker is offline." });
    }
    try {
      const protectedCommands = repositoryOperationOpaqueSchema.parse(
        await bridge.request(
          context.workerId,
          {
            type: "project.script-commands",
            operationId: operationId.data,
            terminalId: context.terminalId,
            serverId,
            worktreePath: context.worktreePath,
            stateProtection: context.stateProtection,
          },
          { timeoutMs: 30_000 },
        ),
      );
      return reply.send(
        protectedScriptCommandListSchema.parse({
          operationId: operationId.data,
          projectId: context.terminalId,
          worktreeId: context.terminalId,
          protectedCommands,
        }),
      );
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { operationId?: string; worktreeId?: string };
  }>("/api/projects/:projectId/script-commands", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    try {
      const context = await resolveAppRunContext(
        request.params.projectId,
        request.query.worktreeId,
      );
      const worktree = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        context.worktreeId,
      );
      if (!worktree || worktree.workerId !== context.workerId) {
        throw new ExecutionLaneConflictError(
          "The script command worktree placement changed before discovery.",
        );
      }
      const protectedCommands = repositoryOperationOpaqueSchema.parse(
        await bridge.request(
          context.workerId,
          {
            type: "project.script-commands.inspect",
            operationId: operationId.data,
            projectId: request.params.projectId,
            worktreeId: context.worktreeId,
            serverId,
            sourcePath: worktree.worktree.path,
          },
          { timeoutMs: 30_000 },
        ),
      );
      return reply.send(
        protectedScriptCommandListSchema.parse({
          operationId: operationId.data,
          projectId: request.params.projectId,
          worktreeId: context.worktreeId,
          protectedCommands,
        }),
      );
    } catch (error) {
      return sendRunApiFailure(reply, error);
    }
  });
}

export function installTerminalWorktreeLifecycleRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    directAttachments,
    repository,
    requireProjectWorktrees,
    workerLinks,
  }: Pick<
    TerminalContextRouteDependencies,
    | "applicationOwnerId"
    | "bridge"
    | "directAttachments"
    | "repository"
    | "requireProjectWorktrees"
    | "workerLinks"
  >,
): void {
  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "terminal",
          request.params.terminalId,
          async () => {
            await workerLinks.revokeResource(
              ownerId,
              "terminal",
              request.params.terminalId,
              "resource-stopped",
            );
            const context = await repository.getTerminalExecutionContext(
              ownerId,
              request.params.terminalId,
            );
            if (context?.kind === "run-configuration") {
              return reply.code(409).send({
                error: "Run configuration terminals cannot change worktrees.",
              });
            }
            if (context) await requireProjectWorktrees(context.projectId);
            const terminal = await repository.updateTerminalWorktree(
              ownerId,
              request.params.terminalId,
              input.data,
            );
            return terminal
              ? reply.send(terminalWireSummarySchema.parse(terminal))
              : reply
                  .code(404)
                  .send({ error: "Terminal or worktree not found." });
          },
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "terminal",
          request.params.terminalId,
          async () => {
            await workerLinks.revokeResource(
              ownerId,
              "terminal",
              request.params.terminalId,
              "resource-deleted",
            );
            const context = await repository.deleteTerminal(
              ownerId,
              request.params.terminalId,
            );
            if (!context) {
              return reply.code(404).send({ error: "Terminal not found." });
            }
            if (bridge.isConnected(context.workerId)) {
              await bridge
                .request(
                  context.workerId,
                  {
                    type: "terminal.close",
                    terminalId: context.terminalId,
                  },
                  { ownerId, timeoutMs: 5_000 },
                )
                .catch((error: unknown) =>
                  app.log.warn(
                    { err: error, terminalId: context.terminalId },
                    "Could not close deleted terminal",
                  ),
                );
            }
            return reply.code(204).send();
          },
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}
