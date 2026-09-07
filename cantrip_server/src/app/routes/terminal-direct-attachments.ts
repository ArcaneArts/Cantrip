import { randomUUID } from "node:crypto";

import {
  directTunnelTicketSchema,
  projectShareDirectCreateSchema,
  terminalOpenResultSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import { authenticatedPrincipal } from "../../auth/principal.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import {
  DirectAttachmentUnavailableError,
  type DirectAttachmentCoordinator,
} from "../../direct-attachments/coordinator.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface TerminalDirectAttachmentRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  directAttachments: Pick<
    DirectAttachmentCoordinator,
    | "acquirePreparationLease"
    | "preparationLeaseIsActive"
    | "prepare"
    | "releasePreparationLease"
    | "revoke"
  >;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getTerminalExecutionContext"
    | "getWorker"
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
}

/** Registers the legacy direct Terminal attachment bootstrap route. */
export function installTerminalDirectAttachmentRoute(
  app: FastifyInstance,
  {
    bridge,
    directAttachments,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
  }: TerminalDirectAttachmentRouteDependencies,
): void {
  app.post<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/direct",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = projectShareDirectCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const principal = authenticatedPrincipal(request);
      const authSessionId = principal.sessionId ?? `local:${principal.user.id}`;
      const preparationLease = directAttachments.acquirePreparationLease({
        authSessionId,
        ownerId: principal.user.id,
        resourceId: request.params.terminalId,
        resourceKind: "terminal",
      });
      if (!preparationLease) {
        return reply.code(409).send({
          error: "The owning resource is being revoked.",
        });
      }
      try {
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
        const assertPreparationActive = () => {
          if (!directAttachments.preparationLeaseIsActive(preparationLease)) {
            throw new DirectAttachmentUnavailableError(
              "The owning resource changed while direct access was opening.",
            );
          }
        };
        assertPreparationActive();
        const worker = await repository.getWorker(
          principal.user.id,
          context.workerId,
        );
        assertPreparationActive();
        if (!worker || !bridge.isConnected(context.workerId)) {
          return reply.code(409).send({ error: "Project worker is offline." });
        }
        const bootstrapAttachmentId = `direct-bootstrap:${randomUUID()}`;
        let startedTerminal = false;
        try {
          assertPreparationActive();
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
            assertPreparationActive();
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
          assertPreparationActive();
          startedTerminal = true;
          const opened = bridge.request(
            context.workerId,
            {
              type: "terminal.open",
              terminalId: context.terminalId,
              attachmentId: bootstrapAttachmentId,
              operationId: randomUUID(),
              serverId,
              worktreePath: context.worktreePath,
              stateProtection: context.stateProtection,
              cols: 80,
              rows: 24,
              outputMode: "discard",
              launch,
            },
            {
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
          assertPreparationActive();
          await bridge.request(context.workerId, {
            type: "terminal.detach",
            terminalId: context.terminalId,
            attachmentId: bootstrapAttachmentId,
          });
          assertPreparationActive();
          await updateTerminalStatus(context.terminalId, "running");
          assertPreparationActive();

          const attachmentId = randomUUID();
          const route = {
            tunnelId: `terminal:${context.terminalId}`,
            attachmentId,
            sourceEndpointId: `desktop:${input.data.clientId}:${attachmentId}`,
            destinationEndpointId: `worker:${context.workerId}`,
          };
          const ticket = await directAttachments.prepare({
            attachmentId,
            authSessionId,
            channels: ["tunnel-data"],
            leaseExpiresAt: new Date(Date.now() + 12 * 60 * 60_000),
            ownerId: principal.user.id,
            preparationLease,
            resourceId: context.terminalId,
            resourceKind: "terminal",
            tunnelRoute: {
              ...route,
              target: {
                kind: "adapter",
                adapter: "terminal",
                resourceId: context.terminalId,
                serverId,
              },
            },
            worker,
          });
          if (!directAttachments.preparationLeaseIsActive(preparationLease)) {
            await directAttachments.revoke(
              ticket.binding.capabilityId,
              "Owning resource was revoked",
            );
            throw new DirectAttachmentUnavailableError(
              "The owning resource changed while direct access was opening.",
            );
          }
          return reply
            .code(201)
            .send(directTunnelTicketSchema.parse({ ...ticket, route }));
        } catch (error) {
          const revoked =
            !directAttachments.preparationLeaseIsActive(preparationLease);
          if (revoked && startedTerminal) {
            await bridge
              .request(
                context.workerId,
                {
                  type: "terminal.close",
                  terminalId: context.terminalId,
                },
                { ownerId: principal.user.id, timeoutMs: 5_000 },
              )
              .catch(() => undefined);
            await updateTerminalStatus(context.terminalId, "idle").catch(
              () => undefined,
            );
          } else {
            await bridge
              .request(context.workerId, {
                type: "terminal.detach",
                terminalId: context.terminalId,
                attachmentId: bootstrapAttachmentId,
              })
              .catch(() => undefined);
          }
          if (error instanceof DirectAttachmentUnavailableError) {
            return reply.code(409).send({ error: error.message });
          }
          return sendWorkerRequestFailure(reply, error);
        }
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
}
