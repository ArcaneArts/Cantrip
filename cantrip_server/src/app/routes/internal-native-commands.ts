import { notifyManagedQueueReceipt } from "../runtime/managed-queue-receipts.js";
import { installInternalNativeSuspensionExecutionRoutes } from "./internal-native-suspension-execution.js";
import { clearAgentInteraction } from "../runtime/clear-agent-interaction.js";
import { applyComputerUseAgentEvent } from "../runtime/computer-use-agent-events.js";
import { nativeCommandEventSchema } from "@cantrip/protocol";
import type { createLiveMutationRuntime } from "../runtime/live-mutation-runtime.js";
import {
  nativeCommandAdmissionSchema,
  nativePermissionTransitionResolveSchema,
  nativeSettingsEvidenceSchema,
  nativeCommandContinuationSchema,
  nativeCommandDispatchSchema,
  nativeCommandSettlementSchema,
  nativePendingRequestSchema,
  nativeInferenceRecoverySchema,
  nativeInferenceRecoveryResultSchema,
  nativeGoalRecoveryFenceSchema,
  nativeGoalRecoveryFenceResultSchema,
  nativeInferenceResourceAuthorizationSchema,
  nativeInferenceResourceAuthorizationResultSchema,
  taskInferenceInputDispatchSchema,
  taskInferenceInputDispatchResultSchema,
  taskGoalCycleDispatchSchema,
  taskGoalCycleDispatchResultSchema,
  taskGoalOutcomeDeliverySchema,
  taskGoalOutcomeCommitSchema,
  TASK_GOAL_OUTCOME_MAX_BYTES,
  type WorkerNotification,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import {
  NativeCommandError,
  type NativeCommandAdmissionResult,
} from "../../db/repository/native-commands.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import { computerUsePreviewAuthority } from "./computer-use-preview.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export function installInternalNativeCommandRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    serverId: string;
    repository: Pick<
      ServerRepository,
      | "nativeCommands"
      | "tasks"
      | "authenticateWorkerCredential"
      | "getWorker"
      | "getChatExecutionContext"
      | "getAgentInteractionRequestByKey"
    >;
    runAsOwner: ApplicationOwnerContext["runAsOwner"];
    bridge?: Pick<WorkerCommandBus, "isConnected" | "connectionIdentity">;
    live: Pick<
      ReturnType<typeof createLiveMutationRuntime>,
      | "publishEncryptedChatMessage"
      | "publishTaskMessage"
      | "publishChatSummary"
      | "publishChatTurnBoundary"
      | "publishChatInvalidation"
    >;
    dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
    queueTaskScheduleTick?: () => void;
    onGoalOutcomeCommitted?: (
      ownerId: string,
      workerId: string,
      notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
    ) => Promise<void>;
  },
): void {
  const { repository, config, serverId, runAsOwner, live } = dependencies;
  app.post(
    "/api/internal/native-commands/inference-resource-authorize",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeInferenceResourceAuthorizationSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-inference-resource" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        // Exact authenticated incarnation, including retained reconnect continuity.
        // Socket availability does not decide canonical resource authorization.
        return (
          input.serverId === serverId &&
          input.ownerId === authentication.ownerId &&
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          const result =
            await repository.nativeCommands.authorizeInferenceResource(
              authentication.ownerId,
              input,
            );
          if (!current())
            return reply.code(409).send({ code: "stale-worker-generation" });
          return nativeInferenceResourceAuthorizationResultSchema.parse(result);
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply
              .code(error.statusCode)
              .send({ code: error.code, error: error.message });
          throw error;
        }
      });
    },
  );
  const authority = (
    ownerId: string,
    result: NativeCommandAdmissionResult,
  ) => ({
    ...result,
    computerUseAuthority:
      ["accepted", "dispatched"].includes(result.receipt.status) &&
      result.execution?.computerUseEnabled &&
      result.receipt.executionLaneId
        ? {
            ...computerUsePreviewAuthority({
              ownerId,
              serverId,
              context: result.execution,
            }),
            executionLaneId: result.receipt.executionLaneId,
          }
        : null,
  });
  installInternalNativeSuspensionExecutionRoutes(app, {
    ...dependencies,
    authority,
  });
  app.post(
    "/api/internal/native-commands/task-goal-outcome",
    { logLevel: "warn", bodyLimit: TASK_GOAL_OUTCOME_MAX_BYTES },
    async (request, reply) => {
      const parsed = taskGoalOutcomeDeliverySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-task-goal-outcome" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      if (
        input.serverId !== serverId ||
        input.ownerId !== authentication.ownerId
      )
        return reply.code(409).send({ code: "stale-outcome-scope" });
      const note = input.notification;
      if (!note.taskInferenceInputOperationId || !note.taskDispatchFence)
        return reply.code(400).send({ code: "invalid-task-goal-outcome" });
      return runAsOwner(authentication.ownerId, async () => {
        let committed;
        let conflict: TaskDispatchConflictError | undefined;
        try {
          // This transaction validates the original physical receipt and saves
          // the protected response/terminal marker, including historical input.
          // No current worker generation is required to deliver an older fact.
          committed =
            input.inputKind === "round"
              ? await repository.tasks.deliverRoundOutcome(
                  authentication.ownerId,
                  input.workerId,
                  note,
                )
              : await repository.tasks.inferenceInputs.goals.applyOutcome(
                  authentication.ownerId,
                  input.workerId,
                  note,
                  { recordOnly: true },
                );
        } catch (error) {
          if (error instanceof TaskDispatchConflictError) conflict = error;
          else throw error;
        }
        const retiredReason = committed
          ? null
          : input.inputKind === "round"
            ? await repository.tasks.roundOutcomeRetirement(
                authentication.ownerId,
                input.workerId,
                note,
              )
            : await repository.tasks.inferenceInputs.goals.outcomeRetirementReason(
                authentication.ownerId,
                note,
                input.workerId,
              );
        if (committed?.message) {
          try {
            live.publishTaskMessage(committed.message, committed.chat);
          } catch (error) {
            app.log.warn(
              {
                err: error,
                workerId: input.workerId,
                event: "task.outcome.publication-pending",
              },
              "Task outcome is committed; live publication remains pending",
            );
          }
        }
        if (conflict && !retiredReason)
          return reply.code(409).send({ code: "stale-task-input" });
        if (committed) {
          try {
            await dependencies.onGoalOutcomeCommitted?.(
              authentication.ownerId,
              input.workerId,
              note,
            );
          } catch (error) {
            app.log.warn(
              {
                err: error,
                workerId: input.workerId,
                event: "task.outcome.follow-up-pending",
              },
              "Task outcome is committed; live follow-up remains pending",
            );
          }
        }
        return taskGoalOutcomeCommitSchema.parse({
          deliveryId: input.deliveryId,
          taskInferenceInputOperationId: note.taskInferenceInputOperationId,
          committed: Boolean(committed),
          ...(retiredReason ? { retiredReason } : {}),
        });
      });
    },
  );
  app.post(
    "/api/internal/native-commands/task-input-dispatch",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = taskInferenceInputDispatchSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-task-input-dispatch" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        return (
          input.serverId === serverId &&
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration &&
          dependencies.bridge?.isConnected(input.workerId)
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return runAsOwner(authentication.ownerId, async () => {
        let result;
        try {
          result = await repository.tasks.inferenceInputs.dispatch(
            authentication.ownerId,
            input.workerId,
            input.receipt,
            input.phase,
            {
              workerGeneration: input.workerGeneration,
              nativeExecution: input.nativeExecution,
              nativeRuntimeGeneration: input.nativeRuntimeGeneration,
            },
          );
        } catch (error) {
          if (error instanceof TaskDispatchConflictError)
            return reply.code(409).send({ code: "stale-task-input" });
          throw error;
        }
        if (!current())
          return reply.code(409).send({ code: "stale-worker-generation" });
        return taskInferenceInputDispatchResultSchema.parse(result);
      });
    },
  );
  app.post(
    "/api/internal/native-commands/task-goal-cycle-dispatch",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = taskGoalCycleDispatchSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ code: "invalid-task-goal-cycle-dispatch" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        return (
          input.serverId === serverId &&
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration &&
          dependencies.bridge?.isConnected(input.workerId)
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          const result =
            await repository.tasks.inferenceInputs.goalCycles.dispatch(
              authentication.ownerId,
              input,
            );
          if (!current())
            return reply.code(409).send({ code: "stale-worker-generation" });
          return taskGoalCycleDispatchResultSchema.parse(result);
        } catch (error) {
          if (error instanceof TaskDispatchConflictError)
            return reply.code(409).send({ code: "stale-task-goal-cycle" });
          throw error;
        }
      });
    },
  );
  app.post(
    "/api/internal/native-commands/goal-recovery-fence",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeGoalRecoveryFenceSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-goal-recovery-fence" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        return (
          input.serverId === serverId &&
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          const result =
            await repository.nativeCommands.fenceGoalRecoveryAdmission(
              authentication.ownerId,
              input,
            );
          if (!current())
            return reply.code(409).send({ code: "stale-worker-generation" });
          return nativeGoalRecoveryFenceResultSchema.parse(result);
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply
              .code(error.statusCode)
              .send({ code: error.code, error: error.message });
          throw error;
        }
      });
    },
  );
  app.post(
    "/api/internal/native-commands/inference-recovery",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeInferenceRecoverySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-inference-recovery" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        return (
          input.serverId === serverId &&
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration &&
          dependencies.bridge?.isConnected(input.workerId)
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return runAsOwner(authentication.ownerId, async () => {
        const result = input.record.identity.recovery?.taskGoalCycle
          ? await repository.tasks.inferenceInputs.goalCycles.reconcile(
              authentication.ownerId,
              input,
            )
          : input.record.identity.recovery?.taskInput
            ? await repository.tasks.inferenceInputs.reconcile(
                authentication.ownerId,
                input,
              )
            : await repository.nativeCommands.reconcileInference(
                authentication.ownerId,
                input,
              );
        if (!current())
          return reply.code(409).send({ code: "stale-worker-generation" });
        if (result.chatId && result.disposition !== "unresolved")
          live.publishChatInvalidation(result.chatId, "chat");
        if (
          result.disposition === "requeued" &&
          (input.record.identity.recovery?.taskInput ||
            input.record.identity.recovery?.taskGoalCycle)
        )
          dependencies.queueTaskScheduleTick?.();
        return nativeInferenceRecoveryResultSchema.parse(result);
      });
    },
  );
  app.post(
    "/api/internal/native-commands/permission-transition",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativePermissionTransitionResolveSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-permission-transition" });
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        parsed.data.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          return await repository.nativeCommands.resolvePermissionTransition(
            authentication.ownerId,
            parsed.data,
          );
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply
              .code(error.statusCode)
              .send({ code: error.code, error: error.message });
          throw error;
        }
      });
    },
  );
  app.post(
    "/api/internal/native-commands/events",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeCommandEventSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-native-event" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          const publication = await repository.nativeCommands.withEventContext(
            authentication.ownerId,
            input.workerId,
            input.operationId,
            input.operationGeneration,
            async (context, transactionRepository) => {
              const attribution =
                context.contextKind === "project"
                  ? {
                      contextKind: "project" as const,
                      executionLaneId: context.executionLaneId!,
                      worktreeId: context.worktreeId,
                      scratchRootId: null,
                    }
                  : {
                      contextKind: "standalone" as const,
                      executionLaneId: context.executionLaneId!,
                      worktreeId: null,
                      scratchRootId: context.scratchRootId,
                    };
              const event = input.event;
              if (
                event.type === "computer-use.approval.request" ||
                event.type === "computer-use.approval.terminal"
              ) {
                await applyComputerUseAgentEvent({
                  event,
                  ownerId: authentication.ownerId,
                  chatId: context.chatId,
                  workerId: input.workerId,
                  projectId: context.projectId,
                  executionLaneId: context.executionLaneId!,
                  record: (...args) =>
                    transactionRepository.recordEncryptedAgentInteractionRequest(
                      ...args,
                    ),
                  terminalize: (...args) =>
                    transactionRepository.terminalizeAgentInteractionRequestFromWorker(
                      ...args,
                    ),
                  lookup: (...args) =>
                    transactionRepository.getAgentInteractionRequestByKey(
                      ...args,
                    ),
                });
              } else if (event.type === "agent.protected-message") {
                const saved =
                  await transactionRepository.upsertEncryptedMessage(
                    authentication.ownerId,
                    context.chatId,
                    event.message,
                    attribution,
                  );
                if (!saved)
                  throw new NativeCommandError("native-event-rejected");
                return () => live.publishEncryptedChatMessage(saved);
              } else if (event.type === "agent.protected-task-message") {
                if (context.experience !== "task")
                  throw new NativeCommandError("native-event-rejected");
                const saved = await transactionRepository.upsertTaskMessage(
                  authentication.ownerId,
                  context.chatId,
                  event.message,
                  attribution,
                );
                if (!saved)
                  throw new NativeCommandError("native-event-rejected");
                return () => live.publishTaskMessage(saved, context);
              } else if (
                event.type === "agent.interaction.requested.protected"
              ) {
                await transactionRepository.recordEncryptedAgentInteractionRequest(
                  {
                    requestKey: event.request.requestKey,
                    projectId: context.projectId,
                    provenance: {
                      chatId: context.chatId,
                      threadId: event.request.threadId,
                      turnId: event.request.turnId,
                      itemId: event.request.itemId,
                      executionLaneId: context.executionLaneId!,
                      workerId: input.workerId,
                    },
                    classification: event.request.classification,
                    protectedPayload: event.request.protectedPayload,
                    expiresAt: event.request.expiresAt,
                  },
                );
              } else if (event.type === "agent.plan.protected") {
                await transactionRepository.updateEncryptedChatPlanState(
                  context.chatId,
                  event.state,
                );
              } else {
                await clearAgentInteraction(event, context, (...args) =>
                  transactionRepository.terminalizeAgentInteractionRequestFromWorker(
                    ...args,
                  ),
                );
              }
              return () => {
                live.publishChatInvalidation(
                  context.chatId,
                  event.type === "agent.plan.protected"
                    ? "chat-plan"
                    : "agent-interaction",
                  null,
                  context,
                );
                live.publishChatSummary(context.chatId, context.projectId);
              };
            },
          );
          publication();
          return { applied: true };
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply.code(error.statusCode).send({ code: error.code });
          throw error;
        }
      });
    },
  );
  app.post(
    "/api/internal/native-commands/pending",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativePendingRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-native-request" });
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        parsed.data.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          await repository.nativeCommands.registerPending(
            authentication.ownerId,
            parsed.data,
          );
          return { registered: true };
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply.code(error.statusCode).send({ code: error.code });
          throw error;
        }
      });
    },
  );
  for (const phase of [
    "admit",
    "continue",
    "dispatch",
    "bind-preparation",
    "receipt",
    "settings-evidence",
  ] as const) {
    app.post(
      `/api/internal/native-commands/${phase}`,
      { logLevel: "warn" },
      async (request, reply) => {
        const parsed = (
          phase === "settings-evidence"
            ? nativeSettingsEvidenceSchema
            : phase === "continue"
              ? nativeCommandContinuationSchema
              : phase === "admit"
                ? nativeCommandAdmissionSchema
                : phase === "dispatch" || phase === "bind-preparation"
                  ? nativeCommandDispatchSchema
                  : nativeCommandSettlementSchema
        ).safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "invalid-native-command" });
        const authentication = await authenticateWorkerRequest(
          repository,
          config,
          request,
          parsed.data.workerId,
          "worker:agent-tools",
        );
        if (!authentication)
          return reply.code(401).send({ code: "unauthorized" });
        if (phase === "receipt") {
          const settlement = nativeCommandSettlementSchema.parse(parsed.data);
          if (settlement.durableSuspension) {
            const connection = dependencies.bridge?.connectionIdentity?.(
              settlement.workerId,
            );
            if (
              !settlement.workerGeneration ||
              connection?.ownerId !== authentication.ownerId ||
              connection.workerProcessGeneration !== settlement.workerGeneration
            )
              return reply.code(409).send({ code: "stale-worker-generation" });
          }
        }
        if (phase === "admit" || phase === "dispatch") {
          const generation =
            phase === "admit"
              ? nativeCommandAdmissionSchema.parse(parsed.data).intent
                  .workerGeneration
              : nativeCommandDispatchSchema.parse(parsed.data).workerGeneration;
          if (generation) {
            const connection = dependencies.bridge?.connectionIdentity?.(
              parsed.data.workerId,
            );
            if (
              connection?.ownerId !== authentication.ownerId ||
              connection.workerProcessGeneration !== generation
            )
              return reply.code(409).send({ code: "stale-worker-generation" });
          }
        }
        if (
          !(await repository.getWorker(
            authentication.ownerId,
            parsed.data.workerId,
          ))
        )
          return reply.code(404).send({ code: "worker-not-found" });
        return runAsOwner(authentication.ownerId, async () => {
          try {
            if (phase === "settings-evidence") {
              const evidence = nativeSettingsEvidenceSchema.parse(parsed.data);
              const result =
                await repository.nativeCommands.recordSettingsEvidence(
                  authentication.ownerId,
                  evidence,
                );
              // The operation already committed and authenticated its exact
              // source. Resolve its immutable chat for live invalidation; a
              // rejection need not produce a new native settings snapshot.
              const receipt = await repository.nativeCommands.lookup(
                authentication.ownerId,
                evidence.workerId,
                evidence.operationId,
              );
              if (receipt) {
                live.publishChatInvalidation(receipt.chatId, "chat");
              }
              return result;
            }
            if (phase === "continue")
              return authority(
                authentication.ownerId,
                await repository.nativeCommands.continueExecution(
                  authentication.ownerId,
                  nativeCommandContinuationSchema.parse(parsed.data),
                ),
              );
            if (phase === "admit") {
              const result = await repository.nativeCommands.admit(
                authentication.ownerId,
                nativeCommandAdmissionSchema.parse(parsed.data),
              );
              if (result.execution)
                live.publishChatSummary(
                  result.execution.chatId,
                  result.execution.projectId,
                );
              if (result.receipt.method === "thread/settings/update")
                live.publishChatInvalidation(result.receipt.chatId, "chat");
              return authority(authentication.ownerId, result);
            }
            if (phase === "bind-preparation")
              return {
                receipt: await repository.nativeCommands.bindPreparation(
                  authentication.ownerId,
                  nativeCommandDispatchSchema.parse(parsed.data),
                ),
              };
            if (phase === "dispatch") {
              const result = await repository.nativeCommands.dispatch(
                authentication.ownerId,
                nativeCommandDispatchSchema.parse(parsed.data),
              );
              if (result.receipt.method === "thread/settings/update")
                live.publishChatInvalidation(result.receipt.chatId, "chat");
              if (
                ["turn/pause", "turn/interrupt"].includes(result.receipt.method)
              ) {
                const context = await repository.getChatExecutionContext(
                  authentication.ownerId,
                  result.receipt.chatId,
                );
                if (context)
                  live.publishChatSummary(context.chatId, context.projectId);
              }
              return authority(authentication.ownerId, result);
            }
            const settlement = nativeCommandSettlementSchema.parse(parsed.data);
            const receipt = await repository.nativeCommands.settle(
              authentication.ownerId,
              settlement,
            );
            if (receipt.method === "thread/settings/update")
              live.publishChatInvalidation(receipt.chatId, "chat");
            if (
              settlement.durableSuspension ||
              settlement.reconciliation?.terminalStatus
            ) {
              const context = await repository.getChatExecutionContext(
                authentication.ownerId,
                receipt.chatId,
              );
              if (context)
                live.publishChatSummary(context.chatId, context.projectId);
            }
            notifyManagedQueueReceipt(receipt.chatId);
            const wakesQueue =
              (settlement.executionComplete && !settlement.deferred) ||
              (receipt.status === "applied" &&
                ["thread/goal/clear", "thread/goal/set"].includes(
                  receipt.method,
                ));
            if (wakesQueue) {
              const context = await repository.getChatExecutionContext(
                authentication.ownerId,
                receipt.chatId,
              );
              if (context) {
                if (settlement.executionComplete)
                  live.publishChatTurnBoundary(
                    context.chatId,
                    context.projectId,
                    context,
                  );
                if (context.status === "idle")
                  void Promise.resolve()
                    .then(() =>
                      dependencies.dispatchNextQueuedPrompt(context.chatId),
                    )
                    .catch(() =>
                      app.log.warn(
                        {
                          chatId: context.chatId,
                          operationId: receipt.operationId,
                        },
                        "Canonical queue dispatch failed after committed native receipt; durable recovery will retry eligible work",
                      ),
                    );
              }
            }
            return { receipt };
          } catch (error) {
            if (error instanceof NativeCommandError)
              return reply.code(error.statusCode).send({ code: error.code });
            throw error;
          }
        });
      },
    );
  }
}
