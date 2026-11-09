import { randomUUID } from "node:crypto";

import {
  encryptedChatTurnCreateSchema,
  projectAutomationProtectedDispatchResultSchema,
} from "@cantrip/protocol";
import {
  projectAutomationDispatchRequestSchema,
  projectAutomationDispatchResultSchema,
  projectAutomationWireListSchema,
} from "@cantrip/protocol/automations";
import type { FastifyInstance } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import type { ServerConfig } from "../../config.js";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import type { ChatTurnStarter } from "./chat-turn-contracts.js";

export interface InternalWorkerAutomationRouteDependencies {
  beginTurn: ChatTurnStarter;
  bridge: Pick<WorkerCommandBus, "request">;
  config: ServerConfig;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
  publishChatInvalidation: (
    chatId: string,
    resource: "chat-queue",
    entityId: string | null,
  ) => void;
  publishProjectAutomationChange: (
    projectId: string,
    automationId: string,
  ) => void;
  repository: Pick<
    ServerRepository,
    | "authenticateWorkerCredential"
    | "createEncryptedQueuedPrompt"
    | "getChatExecutionContext"
    | "getGithubProjectExecutionContext"
    | "getMessageByIdempotencyKey"
    | "getQueuedPromptByIdempotencyKey"
    | "getWorker"
    | "projectAutomations"
  >;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
  schedulerLeaseTtlMs: number;
  serverInstanceId: string;
}

/** Registers worker-authenticated automation polling and dispatch routes. */
export function installInternalWorkerAutomationRoutes(
  app: FastifyInstance,
  {
    beginTurn,
    bridge,
    config,
    dispatchNextQueuedPrompt,
    publishChatInvalidation,
    publishProjectAutomationChange,
    repository,
    resolveModelId,
    runAsOwner,
    schedulerLeaseTtlMs,
    serverInstanceId,
  }: InternalWorkerAutomationRouteDependencies,
): void {
  app.get<{ Querystring: { workerId?: string } }>(
    "/api/internal/workers/automations",
    { logLevel: "warn" },
    async (request, reply) => {
      if (!request.query.workerId) {
        return reply.code(400).send({ error: "workerId is required." });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.query.workerId,
        "worker:automations",
      );
      if (!workerAuth) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (
        !(await repository.getWorker(
          workerAuth.ownerId,
          request.query.workerId,
        ))
      ) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      return reply.send(
        projectAutomationWireListSchema.parse(
          await repository.projectAutomations.listForWorker(
            workerAuth.ownerId,
            request.query.workerId,
          ),
        ),
      );
    },
  );

  app.post<{
    Body: unknown;
    Params: { automationId: string };
    Querystring: { workerId?: string };
  }>(
    "/api/internal/workers/automations/:automationId/dispatch",
    { logLevel: "warn" },
    async (request, reply) => {
      if (!request.query.workerId) {
        return reply.code(400).send({ error: "workerId is required." });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.query.workerId,
        "worker:automations",
      );
      if (!workerAuth) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (
        !(await repository.getWorker(
          workerAuth.ownerId,
          request.query.workerId,
        ))
      ) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      const input = projectAutomationDispatchRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      return runAsOwner(workerAuth.ownerId, async () => {
        const dispatchStartedAtMs = Date.now();
        const claim = await repository.projectAutomations.claimDue(
          workerAuth.ownerId,
          request.query.workerId!,
          request.params.automationId,
          input.data,
          serverInstanceId,
          schedulerLeaseTtlMs,
        );
        if (!claim) {
          serverLogger.debug("Automation dispatch skipped without a lease", {
            event: "automation.dispatch.skipped",
            subsystem: "automation",
            operation: "dispatch",
            status: "skipped",
            reasonCode: "not_due_or_already_claimed",
            requestId: request.id,
            workerId: request.query.workerId,
            automationId: request.params.automationId,
            durationMs: Date.now() - dispatchStartedAtMs,
          });
          const current = await repository.projectAutomations.get(
            workerAuth.ownerId,
            request.params.automationId,
          );
          return reply.send(
            projectAutomationDispatchResultSchema.parse({
              accepted: false,
              status: "skipped",
              nextRunAt: current?.nextRunAt ?? null,
            }),
          );
        }

        const automation = claim.automation;
        publishProjectAutomationChange(automation.projectId, automation.id);
        const finishDispatch = async (
          status: "started" | "queued" | "skipped" | "failed",
          error: string | null = null,
        ): Promise<boolean> => {
          const finalized = await repository.projectAutomations.finishDispatch(
            claim,
            status,
            error,
          );
          if (finalized) {
            publishProjectAutomationChange(automation.projectId, automation.id);
          }
          return finalized;
        };
        serverLogger.info("Automation dispatch lease claimed", {
          event: "automation.dispatch.claimed",
          subsystem: "automation",
          operation: "dispatch",
          status: "claimed",
          requestId: request.id,
          workerId: request.query.workerId,
          projectId: automation.projectId,
          chatId: automation.chatId,
          automationId: automation.id,
          attempt: claim.fencingToken,
        });
        const idempotencyKey = `automation:${automation.id}:${input.data.scheduledFor}`;
        try {
          const context = await repository.getChatExecutionContext(
            workerAuth.ownerId,
            automation.chatId,
          );
          if (!context || context.workerId !== request.query.workerId) {
            throw new Error("The automation target moved to another worker.");
          }
          if (context.experience === "task") {
            throw new Error(
              "Project automation prompts are unavailable for encrypted Tasks.",
            );
          }
          const [existingMessage, existingPrompt] = await Promise.all([
            repository.getMessageByIdempotencyKey(
              workerAuth.ownerId,
              automation.chatId,
              idempotencyKey,
            ),
            repository.getQueuedPromptByIdempotencyKey(
              workerAuth.ownerId,
              automation.chatId,
              idempotencyKey,
            ),
          ]);
          if (existingMessage || existingPrompt) {
            const status = existingPrompt ? "queued" : "started";
            const finalized = await finishDispatch(status);
            if (!finalized) {
              return reply.code(409).send({
                error: "Automation dispatch lease expired before recovery.",
              });
            }
            return reply.code(202).send(
              projectAutomationDispatchResultSchema.parse({
                accepted: true,
                status,
                nextRunAt: claim.nextRunAt?.toISOString() ?? null,
              }),
            );
          }
          const modelId = await resolveModelId(context, undefined);
          const githubContext =
            await repository.getGithubProjectExecutionContext(
              workerAuth.ownerId,
              automation.projectId,
              context.workerId,
            );
          const protectedDispatch =
            projectAutomationProtectedDispatchResultSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "automation.dispatch.protect",
                  automationId: automation.id,
                  content: automation.content,
                  cwd: context.cwd,
                  repository: githubContext?.nameWithOwner ?? null,
                  promptId: randomUUID(),
                  messageId: randomUUID(),
                  mode: "default",
                  modelId,
                  reasoningEffort: claim.reasoningEffort,
                  customSubagentModel:
                    context.modelConfiguration.customSubagentModel,
                  subagentModelId: context.modelConfiguration.subagentModelId,
                  subagentReasoningEffort:
                    context.modelConfiguration.subagentReasoningEffort,
                  idempotencyKey,
                },
                { timeoutMs: 45_000 },
              ),
            );
          if (!protectedDispatch.allowed) {
            const finalized = await finishDispatch("skipped");
            if (!finalized) {
              return reply.code(409).send({
                error: "Automation dispatch lease expired before completion.",
              });
            }
            return reply.code(202).send(
              projectAutomationDispatchResultSchema.parse({
                accepted: true,
                status: "skipped",
                nextRunAt: claim.nextRunAt?.toISOString() ?? null,
              }),
            );
          }
          const protectedTurn = encryptedChatTurnCreateSchema.parse(
            protectedDispatch.protectedTurn,
          );
          let status: "started" | "queued";
          if (context.automationPaused || chatIsExecuting(context.status)) {
            const prompt = await repository.createEncryptedQueuedPrompt(
              workerAuth.ownerId,
              context.chatId,
              protectedTurn.queuedPrompt,
              [],
            );
            if (!prompt) throw new Error("The target chat is unavailable.");
            publishChatInvalidation(prompt.chatId, "chat-queue", prompt.id);
            if (!context.automationPaused) {
              void dispatchNextQueuedPrompt(context.chatId);
            }
            status = "queued";
          } else {
            await beginTurn(
              context,
              {
                text: "Encrypted automation prompt.",
                attachmentIds: [],
                mode: "default",
                modelId,
                reasoningEffort: claim.reasoningEffort,
                customSubagentModel:
                  protectedTurn.queuedPrompt.customSubagentModel,
                subagentModelId: protectedTurn.queuedPrompt.subagentModelId,
                subagentReasoningEffort:
                  protectedTurn.queuedPrompt.subagentReasoningEffort,
                idempotencyKey,
              },
              {
                encryptedChatMessages: {
                  userMessage: protectedTurn.message,
                  response: {
                    id: randomUUID(),
                    idempotencyKey: `assistant:${protectedTurn.message.id}`,
                  },
                },
              },
            );
            status = "started";
          }
          const finalized = await finishDispatch(status);
          if (!finalized) {
            return reply.code(409).send({
              error: "Automation dispatch lease expired before completion.",
            });
          }
          serverLogger.info("Automation dispatch completed", {
            event: "automation.dispatch.completed",
            subsystem: "automation",
            operation: "dispatch",
            status,
            requestId: request.id,
            workerId: request.query.workerId,
            projectId: automation.projectId,
            chatId: automation.chatId,
            automationId: automation.id,
            durationMs: Date.now() - dispatchStartedAtMs,
          });
          return reply.code(202).send(
            projectAutomationDispatchResultSchema.parse({
              accepted: true,
              status,
              nextRunAt: claim.nextRunAt?.toISOString() ?? null,
            }),
          );
        } catch (error) {
          await finishDispatch(
            "failed",
            "Protected automation dispatch failed.",
          );
          serverLogger.warn("Automation dispatch failed", {
            event: "automation.dispatch.failed",
            subsystem: "automation",
            operation: "dispatch",
            status: "failed",
            reasonCode: "protected_dispatch_failed",
            requestId: request.id,
            workerId: request.query.workerId,
            projectId: automation.projectId,
            chatId: automation.chatId,
            automationId: automation.id,
            durationMs: Date.now() - dispatchStartedAtMs,
          });
          void error;
          return reply.code(409).send({
            error: "Protected automation dispatch failed.",
          });
        }
      });
    },
  );
}
