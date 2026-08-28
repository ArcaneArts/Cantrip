import { randomUUID } from "node:crypto";

import {
  terminalOpenResultSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  workerLinkResourceGrantSchema,
  workerLinkTerminalGrantRequestSchema,
} from "@cantrip/protocol/worker-link";
import type { FastifyInstance } from "fastify";

import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import { authenticatedPrincipal } from "../../auth/principal.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { WorkerLinkUnavailableError } from "../../worker-links/coordinator.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../../workers/bridge.js";

export interface WorkerLinkTerminalGrantRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getTerminalExecutionContext"
    | "listEffectiveMcpServers"
  >;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  serverId: string;
  updateTerminalStatus: (
    terminalId: string,
    status: Parameters<ServerRepository["setTerminalStatus"]>[1],
  ) => ReturnType<ServerRepository["setTerminalStatus"]>;
  workerLinks: Pick<
    WorkerLinkService,
    "issueGrant" | "revokeGrant" | "sessionForAuthorization"
  >;
}

/** Registers protected interactive Terminal grants over WorkerLink. */
export function installWorkerLinkTerminalGrantRoute(
  app: FastifyInstance,
  {
    bridge,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
    workerLinks,
  }: WorkerLinkTerminalGrantRouteDependencies,
): void {
  app.post<{ Params: { sessionId: string; terminalId: string } }>(
    "/api/worker-links/:sessionId/terminals/:terminalId/grant",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerLinkTerminalGrantRequestSchema.safeParse(
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
      const context = await repository.getTerminalExecutionContext(
        principal.user.id,
        request.params.terminalId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Terminal not found." });
      }
      if (context.kind === "run-configuration" || !context.stateProtection) {
        return reply.code(409).send({
          error:
            "Run configuration terminals are read-only and use the managed runtime output API.",
        });
      }
      if (context.workerId !== session.identity.workerId) {
        return reply.code(409).send({
          error: "Terminal placement does not match the WorkerLink session.",
        });
      }
      if (!bridge.isConnected(context.workerId)) {
        await updateTerminalStatus(context.terminalId, "offline");
        return reply.code(503).send({ error: "Project worker is offline." });
      }

      const bootstrapAttachmentId = `worker-link-bootstrap:${randomUUID()}`;
      let detached = false;
      try {
        let launch: Extract<
          WorkerCommand,
          { type: "terminal.open" }
        >["launch"] = { type: "shell" };
        if (context.linkedChatId) {
          const chat = await repository.getChatExecutionContext(
            principal.user.id,
            context.linkedChatId,
          );
          const runtime = chat ? await runtimeForContext(chat) : null;
          if (!chat || !runtime) {
            return reply.code(409).send({
              error:
                "Choose a model for this chat before opening its Codex console.",
            });
          }
          launch = {
            type: "codex",
            threadId: chat.threadId,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId: effectivePermissionProfile(chat).effectiveId,
            mcpServers: await repository.listEffectiveMcpServers(
              principal.user.id,
              chat.projectId,
              context.workerId,
            ),
          };
        }
        let markReady: (() => void) | null = null;
        let markFailed: ((error: Error) => void) | null = null;
        let startupTimer: ReturnType<typeof setTimeout> | null = null;
        const ready = new Promise<void>((resolve, reject) => {
          markReady = resolve;
          markFailed = reject;
          startupTimer = setTimeout(
            () => reject(new Error("Terminal process startup timed out.")),
            15_000,
          );
          startupTimer.unref();
        });
        const opened = bridge.request(
          context.workerId,
          {
            type: "terminal.open",
            terminalId: context.terminalId,
            attachmentId: bootstrapAttachmentId,
            operationId: input.data.operationId,
            serverId,
            worktreePath: context.worktreePath,
            stateProtection: context.stateProtection,
            cols: 80,
            rows: 24,
            outputMode: "discard",
            launch,
          },
          {
            ownerId: principal.user.id,
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
            onEvent: (event) => {
              if (event.type === "terminal.ready") markReady?.();
            },
          },
        );
        void opened
          .then((result) => {
            const parsed = terminalOpenResultSchema.parse(result);
            if (parsed.status === "exited") {
              markFailed?.(
                new Error("Terminal process exited during startup."),
              );
            }
          })
          .catch((error: unknown) =>
            markFailed?.(
              error instanceof Error
                ? error
                : new Error("Terminal process could not start."),
            ),
          );
        await ready.finally(() => {
          if (startupTimer) clearTimeout(startupTimer);
        });
        await bridge.request(
          context.workerId,
          {
            type: "terminal.detach",
            terminalId: context.terminalId,
            attachmentId: bootstrapAttachmentId,
          },
          { ownerId: principal.user.id, timeoutMs: 5_000 },
        );
        detached = true;
        terminalOpenResultSchema.parse(await opened);
        await updateTerminalStatus(context.terminalId, "running");
        const grant = await workerLinks.issueGrant({
          attachmentId: input.data.operationId,
          lanes: ["interactive"],
          maxChannels: 1,
          operations: ["stream:open", "stream:read", "stream:write"],
          resourceId: context.terminalId,
          resourceKind: "terminal",
          sessionId: session.sessionId,
        });
        const current = await repository.getTerminalExecutionContext(
          principal.user.id,
          context.terminalId,
        );
        if (
          !current ||
          current.kind === "run-configuration" ||
          current.workerId !== context.workerId ||
          current.worktreePath !== context.worktreePath
        ) {
          await workerLinks.revokeGrant(
            session.sessionId,
            grant.binding.grantId,
            current ? "resource-stopped" : "resource-deleted",
          );
          return reply.code(409).send({
            error: "Terminal placement changed while its stream was opening.",
          });
        }
        return reply.code(201).send(workerLinkResourceGrantSchema.parse(grant));
      } catch (error) {
        if (!detached) {
          await updateTerminalStatus(
            context.terminalId,
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          ).catch(() => undefined);
        }
        if (error instanceof WorkerLinkUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendWorkerRequestFailure(reply, error);
      } finally {
        if (!detached && bridge.isConnected(context.workerId)) {
          await bridge
            .request(
              context.workerId,
              {
                type: "terminal.detach",
                terminalId: context.terminalId,
                attachmentId: bootstrapAttachmentId,
              },
              { ownerId: principal.user.id, timeoutMs: 5_000 },
            )
            .catch(() => undefined);
        }
      }
    },
  );
}
