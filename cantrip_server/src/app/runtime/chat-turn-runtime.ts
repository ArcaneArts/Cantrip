import { randomUUID } from "node:crypto";

import {
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  agentTurnResultSchema,
  chatMessageOpaqueContentSchema,
  chatMessageRelayResultSchema,
  chatTurnRollbackAcceptedSchema,
  mentionedSkillNames,
  modelConfigurationSchema,
  nativeSubagentCapabilityCompatible,
  workerEventIsProvisional,
  type AgentTurnResult,
  type ChatMessage,
  type ChatMessageOpaqueContent,
  type ChatMessageOpaqueSummary,
  type ChatTurnCreate,
  type ReasoningEffort,
  type TaskDispatchWorkerLease,
  type WorkerEvent,
  type WorkerObservationEventIdentity,
} from "@cantrip/protocol";
import {
  taskMessageRelayResultSchema,
  type TaskMessageOpaqueContent,
  type TaskOperationRelayRequest,
} from "@cantrip/protocol/tasks";
import type { WorkflowJsonObject } from "@cantrip/protocol/workflows";
import type { FastifyInstance } from "fastify";

import { ModelBehaviorTracker } from "../../analytics/model-behavior.js";
import {
  canFailOverRoute,
  continuationPrompt,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import {
  TASK_DISPATCH_LEASE_MS,
  TaskDispatchConflictError,
} from "../../db/task-dispatch.js";
import {
  toChatAttachmentOpaqueSummary,
  type ChatExecutionAttribution,
  type ChatExecutionContext,
  type ModelRuntime,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { persistProviderRateLimitActivity } from "../../models/provider-quota.js";
import { taskOperationRelayTurnFields } from "../../tasks/encrypted-relay.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import {
  ROUTE_FAILURE_COOLDOWN_MS,
  STREAMING_WORKER_COMMAND_TIMEOUT_MS,
} from "../shared/constants.js";
import {
  createStreamedFinalTracker,
  hasFinal,
  recordFinal,
} from "../shared/streamed-final-tracker.js";
import {
  workerObservationMessageId,
  workerObservationTurnId,
} from "../shared/worker-observations.js";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;
type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;

export type ChatTurnInput = Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
  attachmentIds?: string[];
  customSubagentModel?: boolean;
  mode?: ChatTurnCreate["mode"];
  subagentModelId?: string | null;
  subagentReasoningEffort?: ReasoningEffort | null;
};

export interface ChatTurnOptions {
  acquiringActor?: "agent" | "user";
  encryptedTaskMessages?: {
    userMessage: TaskMessageOpaqueContent;
    response?: { id: string; idempotencyKey: string };
  };
  encryptedChatMessages?: {
    userMessage: ChatMessageOpaqueContent;
    response: { id: string; idempotencyKey: string };
  };
  messageRole?: "system" | "user";
  purpose?: string;
  retryMessageId?: string;
  runtimes?: ModelRuntime[];
  structuredResult?: {
    outputSchema?: WorkflowJsonObject;
    taskOperation?: TaskOperationRelayRequest;
    afterCompleted?(input: {
      attribution: ChatExecutionAttribution;
      execution: ChatExecutionContext;
      result: AgentTurnResult;
      userMessage: ChatMessage;
    }): Promise<void>;
    onCompleted(input: {
      attribution: ChatExecutionAttribution;
      execution: ChatExecutionContext;
      result: AgentTurnResult;
      userMessage: ChatMessage;
    }): Promise<void>;
    onFailed(input: {
      error: unknown;
      execution: ChatExecutionContext;
      userMessage: ChatMessage;
    }): Promise<void>;
  };
  afterTurnCompleted?(input: {
    attribution: ChatExecutionAttribution;
    execution: ChatExecutionContext;
    result: AgentTurnResult;
    userMessage: ChatMessage;
  }): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  workerPrompt?: string;
  taskDispatchLease?: TaskDispatchWorkerLease;
}

export type BeginChatTurn = (
  context: ChatExecutionContext,
  input: ChatTurnInput,
  options?: ChatTurnOptions,
) => Promise<ChatMessage>;

interface ChatTurnLiveMutationDependencies extends Pick<
  LiveMutationRuntime,
  | "appendLiveChatMessage"
  | "appendLiveEncryptedChatMessage"
  | "appendLiveTaskMessage"
  | "interruptLiveAgentInteractionRequests"
  | "publishChatSummary"
  | "publishChatTurnBoundary"
  | "publishInferenceProgress"
  | "recordLiveAgentInteractionRequest"
  | "recordLiveEncryptedAgentInteractionRequest"
  | "setLiveChatMessageModelRoute"
  | "setLiveEncryptedChatMessageModelRoute"
  | "setLiveTaskMessageModelRoute"
  | "taskMessageServerStub"
  | "terminalizeLiveAgentInteractionRequest"
  | "updateLiveChatPlanMode"
  | "updateLiveEncryptedChatPlanState"
  | "upsertLiveChatMessage"
  | "upsertLiveEncryptedChatMessage"
  | "upsertLiveTaskMessage"
> {}

interface ChatTurnModelRoutingDependencies extends Pick<
  ModelRoutingRuntime,
  | "captureRuntimeQuota"
  | "recordRuntimeModelBehavior"
  | "recordRuntimeTokenUsage"
  | "resolveModelId"
  | "routePairsForConfiguration"
  | "runtimeCanResumeContext"
  | "scheduleRuntimeQuotaSamples"
> {}

export interface ChatTurnRuntimeDependencies
  extends ChatTurnLiveMutationDependencies, ChatTurnModelRoutingDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  cancelChatTurnOutcomeRecovery: (
    workerId: string,
    chatId: string,
    clientMessageId: string,
  ) => void;
  continuePendingWorktreeTransition: (chatId: string) => Promise<boolean>;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
  notifyCodeAgentState: (
    context: Pick<ChatExecutionContext, "chatId" | "cwd" | "workerId">,
    phase: "started" | "completed" | "failed",
    paths?: Iterable<string>,
  ) => Promise<void>;
  prepareCodeEditorsForTurn: (context: ChatExecutionContext) => Promise<void>;
  repository: ServerRepository;
  resolvePromptAttachments: (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => ReturnType<ServerRepository["getChatAttachments"]>;
  routeCooldowns: Map<string, number>;
  runtimeCooldownKey: (runtime: ModelRuntime) => string;
  runAsOwner: OwnerRunner;
}

/**
 * Owns the complete lifecycle of one chat turn, including execution-lane
 * acquisition, worker streaming, persistence, telemetry, and finalization.
 */
export function createChatTurnRuntime({
  app,
  applicationOwnerId,
  appendLiveChatMessage,
  appendLiveEncryptedChatMessage,
  appendLiveTaskMessage,
  bridge,
  cancelChatTurnOutcomeRecovery,
  captureRuntimeQuota,
  continuePendingWorktreeTransition,
  dispatchNextQueuedPrompt,
  interruptLiveAgentInteractionRequests,
  notifyCodeAgentState,
  prepareCodeEditorsForTurn,
  publishChatSummary,
  publishChatTurnBoundary,
  publishInferenceProgress,
  recordLiveAgentInteractionRequest,
  recordLiveEncryptedAgentInteractionRequest,
  recordRuntimeModelBehavior,
  recordRuntimeTokenUsage,
  repository,
  resolveModelId,
  resolvePromptAttachments,
  routeCooldowns,
  routePairsForConfiguration,
  runAsOwner,
  runtimeCanResumeContext,
  runtimeCooldownKey,
  scheduleRuntimeQuotaSamples,
  setLiveChatMessageModelRoute,
  setLiveEncryptedChatMessageModelRoute,
  setLiveTaskMessageModelRoute,
  taskMessageServerStub,
  terminalizeLiveAgentInteractionRequest,
  updateLiveChatPlanMode,
  updateLiveEncryptedChatPlanState,
  upsertLiveChatMessage,
  upsertLiveEncryptedChatMessage,
  upsertLiveTaskMessage,
}: ChatTurnRuntimeDependencies) {
  const beginTurn: BeginChatTurn = async (context, input, options = {}) => {
    const turnStartedAtMs = Date.now();
    const ownerId = applicationOwnerId();
    if (
      context.contextKind === "standalone" &&
      ((input.mode !== undefined && input.mode !== "default") ||
        options.structuredResult ||
        options.encryptedTaskMessages ||
        options.taskDispatchLease)
    ) {
      throw new Error(
        "Standalone Chat supports only ordinary default-mode conversation turns.",
      );
    }
    if (
      options.structuredResult &&
      Boolean(options.structuredResult.outputSchema) ===
        Boolean(options.structuredResult.taskOperation)
    ) {
      throw new Error("Structured turns require exactly one result contract.");
    }
    const encryptedTaskRelay = options.structuredResult?.taskOperation
      ? taskOperationRelayTurnFields(options.structuredResult.taskOperation)
      : null;
    const directTaskOperation =
      options.structuredResult?.taskOperation?.classification.kind === "direct";
    const encryptedTaskMessages = options.encryptedTaskMessages ?? null;
    let encryptedChatMessages = options.encryptedChatMessages ?? null;
    const modelId = await resolveModelId(context, input.modelId);
    const requestedReasoningEffort =
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : context.reasoningEffort;
    const turnModelConfiguration = modelConfigurationSchema.parse({
      modelId,
      reasoningEffort: requestedReasoningEffort,
      customSubagentModel:
        context.contextKind === "standalone"
          ? false
          : (input.customSubagentModel ??
            context.modelConfiguration.customSubagentModel),
      subagentModelId:
        context.contextKind === "standalone"
          ? null
          : input.subagentModelId !== undefined
            ? input.subagentModelId
            : context.modelConfiguration.subagentModelId,
      subagentReasoningEffort:
        context.contextKind === "standalone"
          ? null
          : input.subagentReasoningEffort !== undefined
            ? input.subagentReasoningEffort
            : context.modelConfiguration.subagentReasoningEffort,
    });
    const routePairs = await routePairsForConfiguration(
      context,
      turnModelConfiguration,
      options.runtimes,
    );
    const preparedRuntimes = routePairs.map(({ root }) => root);
    const runtimes = preparedRuntimes.map(({ runtime }) => runtime);
    const attachments = await resolvePromptAttachments(
      context,
      input.attachmentIds ?? [],
    );
    const turnMode = input.mode ?? "default";
    const turnPlanMode = turnMode === "plan" ? "plan" : "default";
    if (
      context.experience === "agent" &&
      !encryptedChatMessages &&
      !options.structuredResult
    ) {
      const userMessage = chatMessageOpaqueContentSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.message.protect",
          message: {
            id: randomUUID(),
            role: options.messageRole ?? "user",
            mode: turnMode,
            reasoningEffort: requestedReasoningEffort,
            content: [
              ...(input.text
                ? [{ type: "text" as const, text: input.text }]
                : []),
              ...attachments.map((attachment) => ({
                type: "attachment" as const,
                attachment: {
                  id: attachment.id,
                  chatId: attachment.chatId,
                  fileName: "Protected attachment",
                  mimeType: "application/octet-stream",
                  sizeBytes: attachment.sizeBytes,
                  kind: "file" as const,
                  source: "file" as const,
                  status: attachment.status,
                  previewText: null,
                  createdAt: attachment.createdAt,
                },
              })),
            ],
            idempotencyKey: input.idempotencyKey,
          },
          attachments: attachments.map((attachment) =>
            toChatAttachmentOpaqueSummary(attachment),
          ),
        }),
      );
      encryptedChatMessages = {
        userMessage,
        response: {
          id: randomUUID(),
          idempotencyKey: `assistant:${userMessage.id}`,
        },
      };
    }
    const effectivePolicies =
      context.contextKind === "project"
        ? await repository.policies.resolveEffective(ownerId, context.projectId)
        : { policies: [] };
    const standalonePolicies =
      context.contextKind === "standalone"
        ? await repository.policies.resolveStandalone(ownerId)
        : { policies: [] };
    if (context.contextKind === "project" && !effectivePolicies) {
      throw new Error("The chat project is no longer available.");
    }
    if (
      context.contextKind === "project" &&
      (!options.structuredResult || directTaskOperation)
    ) {
      await prepareCodeEditorsForTurn(context);
    }
    const mcpServers =
      options.structuredResult && !directTaskOperation
        ? []
        : await repository.listEffectiveMcpServers(
            ownerId,
            context.contextKind === "project" ? context.projectId : null,
            context.workerId,
            context.contextKind === "project" ? "ide" : "chat",
          );
    if (options.taskDispatchLease) {
      await repository.taskDispatch.heartbeat(options.taskDispatchLease);
    }
    const execution = await repository.startChatExecutionLane(
      ownerId,
      context.chatId,
      options.acquiringActor ?? "user",
      options.purpose ?? "Chat turn",
    );
    if (!execution || !execution.executionLaneId) {
      throw new Error("Chat execution lane could not be acquired.");
    }
    publishChatSummary(execution.chatId, execution.projectId);
    const executionLaneId = execution.executionLaneId;
    const attribution: ChatExecutionAttribution =
      execution.contextKind === "project"
        ? {
            contextKind: "project",
            executionLaneId,
            worktreeId: execution.worktreeId,
            scratchRootId: null,
          }
        : {
            contextKind: "standalone",
            executionLaneId,
            worktreeId: null,
            scratchRootId: execution.scratchRootId,
          };
    let priorMessages: ChatMessage[] = [];
    let protectedHistory: ChatMessageOpaqueSummary[] = [];
    let protectedPlan = null;
    let userMessage: ChatMessage;
    let immediateCorrectiveFollowup = false;
    try {
      if (options.retryMessageId) {
        const retryRuntime = runtimes[0]!;
        if (
          !execution.threadId ||
          !runtimeCanResumeContext(execution, retryRuntime)
        ) {
          throw new Error(
            "The original Codex runtime is unavailable for this message.",
          );
        }
        const rollback = chatTurnRollbackAcceptedSchema.parse(
          await bridge.request(execution.workerId, {
            type: "chat.turn.rollback",
            executionProfile:
              execution.contextKind === "standalone"
                ? "standalone-chat"
                : "ide",
            chatId: execution.chatId,
            clientMessageId: options.retryMessageId,
            cwd: execution.cwd,
            threadId: execution.threadId,
            model: retryRuntime.model,
            provider: retryRuntime.provider,
            permissionProfileId:
              effectivePermissionProfile(execution).effectiveId,
          }),
        );
        if (!rollback.rolledBack) {
          throw new Error("The previous Codex turn could not be rolled back.");
        }
        const trimmed = await repository.trimLatestEncryptedTurn(
          ownerId,
          execution.chatId,
          options.retryMessageId,
        );
        if (!trimmed) {
          throw new Error(
            "Only the latest user message can be edited and sent again.",
          );
        }
      }
      await updateLiveChatPlanMode(ownerId, execution.chatId, turnPlanMode);
      const priorHeaders = await repository.listMessageHeaders(
        ownerId,
        execution.chatId,
      );
      for (let index = priorHeaders.length - 1; index >= 0; index -= 1) {
        const message = priorHeaders[index]!;
        if (message.role !== "assistant") continue;
        const elapsedMs = turnStartedAtMs - Date.parse(message.createdAt);
        immediateCorrectiveFollowup =
          Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 120_000;
        break;
      }
      if (encryptedChatMessages) {
        protectedHistory = await repository.listEncryptedMessages(
          ownerId,
          execution.chatId,
        );
        protectedPlan = await repository.getEncryptedChatPlanState(
          ownerId,
          execution.chatId,
        );
        const appended = await appendLiveEncryptedChatMessage(
          ownerId,
          execution.chatId,
          encryptedChatMessages.userMessage,
          attribution,
        );
        if (!appended) throw new Error("Encrypted Chat not found.");
        userMessage = taskMessageServerStub(appended);
        await setLiveEncryptedChatMessageModelRoute(
          ownerId,
          userMessage.id,
          modelId,
          runtimes[0]!,
          {
            appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
            reasoningAdjusted: preparedRuntimes[0]!.adjusted,
          },
        );
      } else if (encryptedTaskMessages) {
        const appended = await appendLiveTaskMessage(
          ownerId,
          execution.chatId,
          encryptedTaskMessages.userMessage,
          attribution,
          execution,
        );
        if (!appended) throw new Error("Encrypted Task Chat not found.");
        userMessage = taskMessageServerStub(appended);
        await setLiveTaskMessageModelRoute(
          ownerId,
          userMessage.id,
          modelId,
          runtimes[0]!,
          {
            appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
            reasoningAdjusted: preparedRuntimes[0]!.adjusted,
          },
          execution,
        );
      } else {
        throw new Error("Chat turn content was not encrypted.");
      }
      app.log.info(
        {
          event: "chat.turn.accepted",
          subsystem: "chat-execution",
          operation: "turn",
          status: "accepted",
          chatId: execution.chatId,
          clientMessageId: userMessage.id,
          executionLaneId,
          modelId,
          providerAccountId: runtimes[0]!.provider.accountId,
          providerId: runtimes[0]!.provider.id,
          workerId: execution.workerId,
          projectId: execution.projectId,
        },
        "Agent turn accepted",
      );
      if (options.taskDispatchLease) {
        await repository.taskDispatch.markRunning(options.taskDispatchLease);
      }
    } catch (error) {
      await repository.finishChatExecutionLane(
        execution.chatId,
        executionLaneId,
        "failed",
      );
      publishChatSummary(execution.chatId, execution.projectId);
      throw error;
    }

    const attributedWorker = await repository.getWorker(
      ownerId,
      execution.workerId,
    );
    void runAsOwner(ownerId, async () => {
      let anyActivity = false;
      let workerObservationSequence = 0;
      const observationIdentity = (
        event: WorkerEvent,
      ): WorkerObservationEventIdentity => {
        const sequence =
          event.type === "agent.inference-progress"
            ? event.progress.sequence
            : workerObservationSequence;
        if (
          event.type !== "agent.inference-progress" &&
          workerEventIsProvisional(event)
        ) {
          workerObservationSequence += 1;
        }
        return {
          operationId: userMessage.id,
          turnId: workerObservationTurnId(event),
          messageId: workerObservationMessageId(event),
          sequence,
        };
      };
      const changedPaths = new Set<string>();
      const taskDispatchHeartbeat = options.taskDispatchLease
        ? setInterval(
            () => {
              void repository.taskDispatch
                .heartbeat(options.taskDispatchLease!)
                .catch((error) => {
                  if (error instanceof TaskDispatchConflictError) return;
                  app.log.warn(
                    { chatId: execution.chatId, err: error },
                    "Could not renew the Task dispatch lease",
                  );
                });
            },
            Math.floor(TASK_DISPATCH_LEASE_MS / 3),
          )
        : null;
      taskDispatchHeartbeat?.unref();
      try {
        if (execution.contextKind === "project") {
          await notifyCodeAgentState(execution, "started");
        }
        for (const [index, runtime] of runtimes.entries()) {
          const executionAttemptId = `${userMessage.id}:${runtime.routeId}:${index}`;
          const tokenUsageSourceKey = `chat-attempt:${executionAttemptId}`;
          const behaviorSourceKey = `chat-attempt:${executionAttemptId}`;
          const behaviorTracker = new ModelBehaviorTracker();
          const attemptStartedAt = new Date();
          let quotaFollowupsScheduled = false;
          const attemptStartedAtMs = Date.now();
          let behaviorTurnId: string | null = null;
          const preparedReasoning = preparedRuntimes[index]!;
          const subagentRuntime = routePairs[index]!.subagent?.runtime ?? null;
          const recordChildAgentTime = async (
            telemetry:
              | {
                  agentThreadId: string;
                  completedAtMs: number | null;
                  isRoot: boolean;
                  startedAtMs: number | null;
                  status: "running" | "completed" | "failed";
                }
              | null
              | undefined,
            childTurnId: string | null,
          ) => {
            if (!telemetry || telemetry.isRoot || !childTurnId) return;
            const childExecutionAttemptId = `${executionAttemptId}:subagent:${telemetry.agentThreadId}:${childTurnId}`;
            const dateFromTelemetry = (value: number | null) => {
              if (value === null) return undefined;
              const date = new Date(value);
              return Number.isNaN(date.getTime()) ? undefined : date;
            };
            const startedAt = dateFromTelemetry(telemetry.startedAtMs);
            const completedAt =
              telemetry.status === "running"
                ? null
                : (dateFromTelemetry(telemetry.completedAtMs) ?? new Date());
            await recordRuntimeTokenUsage(
              `chat-subagent:${childExecutionAttemptId}`,
              execution.projectId,
              execution.chatId,
              subagentRuntime ?? runtime,
              undefined,
              {
                workerId: execution.workerId,
                turnId: childTurnId,
                executionAttemptId: childExecutionAttemptId,
                attemptKind: "subagent-turn",
                attemptStatus: telemetry.status,
                startedAt,
                completedAt,
                finalizedAt: completedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
          };
          let attemptActivity = false;
          const canResume = runtimeCanResumeContext(execution, runtime);
          const threadId = canResume ? execution.threadId : null;
          const finals = createStreamedFinalTracker();
          const requestedPrompt =
            encryptedTaskRelay?.prompt ??
            options.workerPrompt ??
            (input.text ||
              "Review the attached files and respond to the user.");
          const workerPrompt = encryptedTaskRelay
            ? encryptedTaskRelay.prompt
            : threadId
              ? requestedPrompt
              : continuationPrompt(priorMessages, requestedPrompt);
          if (index > 0) {
            const setRoute = encryptedChatMessages
              ? setLiveEncryptedChatMessageModelRoute
              : encryptedTaskMessages
                ? setLiveTaskMessageModelRoute
                : setLiveChatMessageModelRoute;
            await setRoute(ownerId, userMessage.id, modelId, runtime, {
              appliedReasoningEffort: preparedReasoning.appliedReasoningEffort,
              reasoningAdjusted: preparedReasoning.adjusted,
            });
          }
          if (
            !encryptedTaskMessages &&
            !encryptedChatMessages &&
            preparedReasoning.adjusted &&
            requestedReasoningEffort
          ) {
            await appendLiveChatMessage(
              ownerId,
              execution.chatId,
              {
                role: "system",
                content: [
                  {
                    type: "activity",
                    activity: {
                      id: `reasoning-adjustment:${userMessage.id}:${runtime.routeId}`,
                      type: "notice",
                      status: "completed",
                      level: "warning",
                      message: `${runtime.provider.name} does not advertise ${requestedReasoningEffort} reasoning for ${runtime.model.name}; this attempt uses the provider default.`,
                      details: null,
                      willRetry: null,
                    },
                  },
                ],
                idempotencyKey: `reasoning-adjustment:${userMessage.id}:${runtime.routeId}:${runtime.provider.accountId ?? "provider"}`,
              },
              attribution,
            );
          }
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            threadId,
            runtime.routeId,
            "starting",
            runtime.provider.accountId,
            execution.scratchRootId,
          );
          captureRuntimeQuota(
            runtime,
            execution,
            index > 0 &&
              runtimes[index - 1]?.provider.accountId !==
                runtime.provider.accountId
              ? "account-switch"
              : "turn-starting",
            executionAttemptId,
          );
          await recordRuntimeTokenUsage(
            tokenUsageSourceKey,
            execution.projectId,
            execution.chatId,
            runtime,
            undefined,
            {
              workerId: execution.workerId,
              executionAttemptId,
              attemptKind: "chat-turn",
              attemptStatus: "running",
              startedAt: attemptStartedAt,
              codexVersion: attributedWorker?.codexVersion ?? null,
            },
          );
          await recordRuntimeModelBehavior(
            behaviorSourceKey,
            execution,
            runtime,
            behaviorTracker,
            {
              executionAttemptId,
              attemptStatus: "running",
              routeAttemptIndex: index,
              retryFailoverCount: index,
              startedAt: attemptStartedAt,
              immediateCorrectiveFollowup,
              userRetryRegeneration: Boolean(options.retryMessageId),
              codexVersion: attributedWorker?.codexVersion ?? null,
            },
          );
          try {
            app.log.debug(
              {
                event: "chat.turn.route-dispatched",
                subsystem: "chat-execution",
                operation: "turn",
                status: "dispatching",
                chatId: execution.chatId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                attempt: index + 1,
                counts: { candidateRoutes: runtimes.length },
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
              },
              "Agent turn route dispatched",
            );
            const rawResult = await bridge.request(
              execution.workerId,
              {
                type: "chat.turn",
                executionProfile:
                  execution.contextKind === "standalone"
                    ? "standalone-chat"
                    : "ide",
                contextKind: execution.contextKind,
                chatId: execution.chatId,
                clientMessageId: userMessage.id,
                cwd: execution.cwd,
                executionLaneId,
                worktreeId: execution.worktreeId,
                scratchRootId: execution.scratchRootId,
                rootKind: execution.rootKind,
                threadId,
                isPrimary: execution.isPrimary,
                worktreeMode: execution.worktreeMode,
                worktreePolicy: execution.worktreePolicy,
                policyProjectId: execution.projectId,
                policies: effectivePolicies ?? { policies: [] },
                standalonePolicies,
                ...(encryptedChatMessages
                  ? {
                      protectedPrompt: encryptedChatMessages.userMessage,
                      protectedHistory,
                      protectedPlan,
                    }
                  : {
                      prompt: workerPrompt,
                      protectedHistory: [],
                      protectedPlan: null,
                    }),
                attachments: attachments.map((attachment) =>
                  toChatAttachmentOpaqueSummary(attachment),
                ),
                skillNames:
                  execution.contextKind === "standalone" ||
                  options.structuredResult ||
                  encryptedChatMessages
                    ? []
                    : mentionedSkillNames(input.text),
                chatSkillAudienceKeys:
                  execution.contextKind === "standalone"
                    ? await repository.listChatSkillAudienceKeys(
                        ownerId,
                        execution.workerId,
                        runtime.provider.id,
                      )
                    : [],
                model: runtime.model,
                provider: runtime.provider,
                subagentDefaults:
                  execution.contextKind === "project" && subagentRuntime
                    ? {
                        model: subagentRuntime.model,
                        provider: subagentRuntime.provider,
                      }
                    : null,
                ...(execution.contextKind === "project" &&
                attributedWorker &&
                nativeSubagentCapabilityCompatible(
                  attributedWorker.codexRuntime.nativeSubagents,
                )
                  ? {
                      subagentProtocolVersion: NATIVE_SUBAGENT_PROTOCOL_VERSION,
                    }
                  : {}),
                permissionProfileId:
                  effectivePermissionProfile(execution).effectiveId,
                planMode: turnPlanMode,
                mcpServers,
                automationPaused: execution.automationPaused,
                resultMode: options.structuredResult
                  ? (encryptedTaskRelay?.resultMode ?? {
                      kind: "structured" as const,
                      outputSchema: options.structuredResult.outputSchema!,
                    })
                  : encryptedTaskMessages?.response
                    ? {
                        kind: "task-message-encrypted" as const,
                        messageId: encryptedTaskMessages.response.id,
                        idempotencyKey:
                          encryptedTaskMessages.response.idempotencyKey,
                      }
                    : encryptedChatMessages
                      ? {
                          kind: "chat-message-encrypted" as const,
                          messageId: encryptedChatMessages.response.id,
                          idempotencyKey:
                            encryptedChatMessages.response.idempotencyKey,
                        }
                      : { kind: "visible" },
                taskDispatchLease: options.taskDispatchLease,
              },
              {
                timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
                onEvent: (event) =>
                  runAsOwner(ownerId, async () => {
                    const observedAt = new Date();
                    const sourceEvent = observationIdentity(event);
                    behaviorTracker.markActivity(observedAt);
                    attemptActivity = true;
                    anyActivity = true;
                    if (execution.contextKind === "standalone") {
                      const protectedAgentRuntime =
                        (event.type === "agent.protected-message" ||
                          event.type === "agent.protected-task-message") &&
                        event.telemetry.kind === "activity"
                          ? event.telemetry.agentRuntime
                          : null;
                      const visibleAgentScope =
                        event.type === "agent.activity"
                          ? event.activity.agentScope
                          : null;
                      if (
                        (protectedAgentRuntime &&
                          !protectedAgentRuntime.isRoot) ||
                        (visibleAgentScope && !visibleAgentScope.isRoot)
                      ) {
                        throw new Error(
                          "Standalone Chat runtime emitted child-agent lifecycle activity.",
                        );
                      }
                    }
                    if (event.type === "agent.inference-progress") {
                      if (event.progress.requestId !== userMessage.id) return;
                      publishInferenceProgress(
                        execution.chatId,
                        event.progress,
                      );
                      return;
                    }
                    if (event.type === "agent.interaction.requested") {
                      if (encryptedChatMessages) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Encrypted chat interactions must use the protected contract.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw new Error(
                          "The worker emitted a visible interaction for an encrypted chat turn.",
                        );
                      }
                      behaviorTurnId = event.request.turnId ?? behaviorTurnId;
                      behaviorTracker.markApproval(
                        event.request.requestKey,
                        observedAt,
                      );
                      try {
                        await recordLiveAgentInteractionRequest({
                          requestKey: event.request.requestKey,
                          projectId: execution.projectId,
                          provenance: {
                            chatId: execution.chatId,
                            threadId: event.request.threadId,
                            turnId: event.request.turnId,
                            itemId: event.request.itemId,
                            executionLaneId,
                            workflowRunId: null,
                            workflowNodeId: null,
                            workerId: execution.workerId,
                          },
                          payload: event.request.payload,
                          expiresAt: event.request.expiresAt,
                        });
                      } catch (error) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Cantrip could not persist the interaction safely.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw error;
                      }
                      return;
                    }
                    if (
                      event.type === "agent.interaction.requested.protected"
                    ) {
                      behaviorTurnId = event.request.turnId ?? behaviorTurnId;
                      behaviorTracker.markApproval(
                        event.request.requestKey,
                        observedAt,
                      );
                      try {
                        await recordLiveEncryptedAgentInteractionRequest({
                          requestKey: event.request.requestKey,
                          projectId: execution.projectId,
                          provenance: {
                            chatId: execution.chatId,
                            threadId: event.request.threadId,
                            turnId: event.request.turnId,
                            itemId: event.request.itemId,
                            executionLaneId,
                            workflowRunId: null,
                            workflowNodeId: null,
                            workerId: execution.workerId,
                          },
                          classification: event.request.classification,
                          protectedPayload: event.request.protectedPayload,
                          expiresAt: event.request.expiresAt,
                        });
                      } catch (error) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Cantrip could not persist the protected interaction safely.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw error;
                      }
                      return;
                    }
                    if (
                      event.type === "agent.interaction.cleared" ||
                      event.type === "agent.interaction.expired"
                    ) {
                      await terminalizeLiveAgentInteractionRequest(
                        event.requestKey,
                        execution.chatId,
                        execution.workerId,
                        event.type === "agent.interaction.expired"
                          ? "expired"
                          : "interrupted",
                      );
                      return;
                    }
                    if (event.type === "agent.protected-task-message") {
                      if (!encryptedTaskRelay && !encryptedTaskMessages) {
                        throw new Error(
                          "Received a protected Task event for a non-Task turn.",
                        );
                      }
                      behaviorTurnId = event.telemetry.turnId ?? behaviorTurnId;
                      if (event.telemetry.kind === "activity") {
                        await recordChildAgentTime(
                          event.telemetry.agentRuntime,
                          event.telemetry.turnId,
                        );
                      }
                      if (event.telemetry.kind === "message") {
                        const completedFinal =
                          event.telemetry.phase !== "commentary" &&
                          !event.telemetry.streaming;
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                        if (completedFinal) {
                          recordFinal(
                            finals,
                            event.telemetry.turnId,
                            event.message.id,
                          );
                        }
                      } else if (event.telemetry.kind === "usage") {
                        behaviorTracker.observeUsage(
                          {
                            inputTokens: event.telemetry.usage.inputTokens,
                            cachedInputTokens:
                              event.telemetry.usage.cachedInputTokens,
                            cacheWriteInputTokens:
                              event.telemetry.usage.cacheWriteInputTokens,
                            outputTokens: event.telemetry.usage.outputTokens,
                            reasoningOutputTokens:
                              event.telemetry.usage.reasoningOutputTokens,
                            modelContextWindow:
                              event.telemetry.modelContextWindow,
                            contextUsedPercent:
                              event.telemetry.contextUsedPercent,
                          },
                          observedAt,
                        );
                        await recordRuntimeTokenUsage(
                          tokenUsageSourceKey,
                          execution.projectId,
                          execution.chatId,
                          runtime,
                          event.telemetry.usage,
                          {
                            workerId: execution.workerId,
                            turnId:
                              event.telemetry.turnId ??
                              behaviorTurnId ??
                              event.message.id,
                            executionAttemptId,
                            attemptKind: "chat-turn",
                            attemptStatus: "running",
                            codexVersion:
                              attributedWorker?.codexVersion ?? null,
                          },
                        );
                      } else if (event.telemetry.kind === "activity") {
                        behaviorTracker.markActivity(observedAt);
                      }
                      const saved = await upsertLiveTaskMessage(
                        ownerId,
                        execution.chatId,
                        event.message,
                        attribution,
                        execution,
                      );
                      if (!saved) {
                        throw new Error("Encrypted Task message was rejected.");
                      }
                      return;
                    }
                    if (event.type === "agent.protected-message") {
                      behaviorTurnId = event.telemetry.turnId ?? behaviorTurnId;
                      if (event.telemetry.kind === "activity") {
                        await recordChildAgentTime(
                          event.telemetry.agentRuntime,
                          event.telemetry.turnId,
                        );
                      }
                      if (event.telemetry.kind === "message") {
                        const completedFinal =
                          event.telemetry.phase !== "commentary" &&
                          !event.telemetry.streaming;
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                        if (completedFinal) {
                          recordFinal(
                            finals,
                            event.telemetry.turnId,
                            event.message.id,
                          );
                        }
                      } else if (event.telemetry.kind === "usage") {
                        behaviorTracker.observeUsage(
                          {
                            inputTokens: event.telemetry.usage.inputTokens,
                            cachedInputTokens:
                              event.telemetry.usage.cachedInputTokens,
                            cacheWriteInputTokens:
                              event.telemetry.usage.cacheWriteInputTokens,
                            outputTokens: event.telemetry.usage.outputTokens,
                            reasoningOutputTokens:
                              event.telemetry.usage.reasoningOutputTokens,
                            modelContextWindow:
                              event.telemetry.modelContextWindow,
                            contextUsedPercent:
                              event.telemetry.contextUsedPercent,
                          },
                          observedAt,
                        );
                        await recordRuntimeTokenUsage(
                          tokenUsageSourceKey,
                          execution.projectId,
                          execution.chatId,
                          runtime,
                          event.telemetry.usage,
                          {
                            workerId: execution.workerId,
                            turnId:
                              event.telemetry.turnId ??
                              behaviorTurnId ??
                              event.message.id,
                            executionAttemptId,
                            attemptKind: "chat-turn",
                            attemptStatus: "running",
                            codexVersion:
                              attributedWorker?.codexVersion ?? null,
                          },
                        );
                      } else if (event.telemetry.kind === "activity") {
                        behaviorTracker.markActivity(observedAt);
                      } else {
                        behaviorTracker.markVisibleResponse(true, observedAt);
                        recordFinal(
                          finals,
                          event.telemetry.turnId,
                          event.message.id,
                        );
                      }
                      const saved = await upsertLiveEncryptedChatMessage(
                        ownerId,
                        execution.chatId,
                        event.message,
                        attribution,
                      );
                      if (!saved) {
                        throw new Error("Encrypted Chat message was rejected.");
                      }
                      return;
                    }
                    if (event.type === "agent.message") {
                      const turnId = event.message.correlation?.turnId;
                      behaviorTurnId = turnId ?? behaviorTurnId;
                      const completedFinal =
                        event.message.phase !== "commentary" &&
                        !event.message.streaming;
                      if (event.message.text.trim()) {
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                      }
                      if (
                        options.structuredResult &&
                        event.message.phase !== "commentary"
                      ) {
                        return;
                      }
                      await upsertLiveChatMessage(
                        ownerId,
                        execution.chatId,
                        {
                          role: "assistant",
                          content: [
                            {
                              type: "text",
                              text: event.message.text,
                              phase: event.message.phase,
                              ...(event.message.streaming
                                ? { streaming: true }
                                : {}),
                              correlation: event.message.correlation,
                              sourceEvent,
                            },
                          ],
                          idempotencyKey: `agent-message:${turnId ?? userMessage.id}:${event.message.id}`,
                        },
                        attribution,
                      );
                      if (completedFinal) {
                        recordFinal(finals, turnId, event.message.text);
                      }
                      return;
                    }
                    if (event.type === "agent.checkpoint") {
                      if (options.structuredResult) return;
                      if (!event.text.trim()) return;
                      if (finals.turnIds.has(event.turnId)) return;
                      behaviorTurnId = event.turnId;
                      behaviorTracker.markVisibleResponse(true, observedAt);
                      await upsertLiveChatMessage(
                        ownerId,
                        execution.chatId,
                        {
                          role: "assistant",
                          content: [
                            {
                              type: "text",
                              text: event.text,
                              phase: "final_answer",
                            },
                          ],
                          idempotencyKey: `goal-checkpoint:${userMessage.id}:${event.turnId}`,
                        },
                        attribution,
                      );
                      return;
                    }
                    if (event.type === "agent.plan.protected") {
                      if (!encryptedChatMessages) {
                        throw new Error(
                          "Received protected Plan Mode state for a non-chat-encrypted turn.",
                        );
                      }
                      await updateLiveEncryptedChatPlanState(
                        execution.chatId,
                        event.state,
                      );
                      return;
                    }
                    if (event.type === "agent.plan.updated") {
                      throw new Error(
                        "Worker emitted plaintext Plan Mode state.",
                      );
                    }
                    if (event.type === "agent.plan.question") {
                      throw new Error(
                        "Worker emitted a plaintext Plan Mode question.",
                      );
                    }
                    if (event.type === "agent.plan.question-resolved") {
                      throw new Error(
                        "Worker emitted a plaintext Plan Mode resolution.",
                      );
                    }
                    if (event.type !== "agent.activity") return;
                    behaviorTurnId =
                      event.activity.correlation?.turnId ?? behaviorTurnId;
                    if (
                      event.activity.type === "turnSummary" &&
                      event.activity.agentScope
                    ) {
                      await recordChildAgentTime(
                        {
                          agentThreadId:
                            event.activity.agentScope.agentThreadId,
                          isRoot: event.activity.agentScope.isRoot,
                          startedAtMs:
                            event.activity.startedAt === null
                              ? null
                              : event.activity.startedAt * 1_000,
                          completedAtMs:
                            event.activity.completedAt === null
                              ? null
                              : event.activity.completedAt * 1_000,
                          status:
                            event.activity.status === "running"
                              ? "running"
                              : event.activity.status === "completed"
                                ? "completed"
                                : "failed",
                        },
                        event.activity.correlation?.turnId ?? null,
                      );
                    }
                    behaviorTracker.observeActivity(event.activity, observedAt);
                    if (event.activity.type === "usage") {
                      const usageTurnId =
                        event.activity.correlation?.turnId ?? event.activity.id;
                      await recordRuntimeTokenUsage(
                        tokenUsageSourceKey,
                        execution.projectId,
                        execution.chatId,
                        runtime,
                        event.activity.last,
                        {
                          workerId: execution.workerId,
                          turnId: usageTurnId,
                          executionAttemptId,
                          attemptKind: "chat-turn",
                          attemptStatus: "running",
                          codexVersion: attributedWorker?.codexVersion ?? null,
                        },
                      );
                    }
                    if (
                      event.activity.type === "rateLimit" &&
                      runtime.provider.accountId
                    ) {
                      await persistProviderRateLimitActivity(
                        repository,
                        {
                          ownerId,
                          providerId: runtime.provider.id,
                          accountId: runtime.provider.accountId,
                          accountPlanType: event.activity.planType,
                          workerId: execution.workerId,
                          trigger: "live-rate-limit-update",
                          chatId: execution.chatId,
                          turnId: event.activity.correlation?.turnId ?? null,
                          executionAttemptId,
                        },
                        event.activity,
                      ).catch((error) => {
                        app.log.warn(
                          {
                            accountId: runtime.provider.accountId,
                            err: error,
                            providerId: runtime.provider.id,
                          },
                          "Unable to persist provider quota observation",
                        );
                      });
                    }
                    if (event.activity.type === "fileChange") {
                      for (const change of event.activity.changes) {
                        changedPaths.add(change.path);
                      }
                    }
                    await upsertLiveChatMessage(
                      ownerId,
                      execution.chatId,
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "activity",
                            activity: event.activity,
                            sourceEvent,
                          },
                        ],
                        idempotencyKey:
                          event.activity.type === "worktree"
                            ? event.activity.id
                            : `activity:${userMessage.id}:${event.activity.id}`,
                      },
                      attribution,
                    );
                  }),
              },
            );
            cancelChatTurnOutcomeRecovery(
              execution.workerId,
              execution.chatId,
              userMessage.id,
            );
            const result = agentTurnResultSchema.parse(rawResult);
            const completedAt = new Date();
            behaviorTurnId = result.turnId ?? behaviorTurnId;
            if (result.text.trim()) {
              behaviorTracker.markVisibleResponse(true, completedAt);
            }
            await recordRuntimeTokenUsage(
              tokenUsageSourceKey,
              execution.projectId,
              execution.chatId,
              runtime,
              result.measuredUsage ?? undefined,
              {
                workerId: execution.workerId,
                turnId: result.turnId ?? null,
                executionAttemptId,
                attemptKind: "chat-turn",
                attemptStatus: "completed",
                completedAt,
                finalizedAt: completedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            await recordRuntimeModelBehavior(
              behaviorSourceKey,
              execution,
              runtime,
              behaviorTracker,
              {
                executionAttemptId,
                attemptStatus: "completed",
                routeAttemptIndex: index,
                retryFailoverCount: index,
                startedAt: attemptStartedAt,
                completedAt,
                finalizedAt: completedAt,
                durationMs: completedAt.getTime() - attemptStartedAtMs,
                turnId: behaviorTurnId,
                immediateCorrectiveFollowup,
                userRetryRegeneration: Boolean(options.retryMessageId),
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            scheduleRuntimeQuotaSamples(
              runtime,
              execution,
              executionAttemptId,
              result.turnId ?? null,
            );
            quotaFollowupsScheduled = true;
            if (execution.contextKind === "project") {
              await notifyCodeAgentState(execution, "completed", changedPaths);
            }
            routeCooldowns.delete(runtimeCooldownKey(runtime));
            await repository.updateChatRuntime(
              execution.chatId,
              execution.workerId,
              execution.worktreeId,
              result.threadId,
              runtime.routeId,
              "ready",
              runtime.provider.accountId,
              execution.scratchRootId,
            );
            if (options.structuredResult) {
              await options.structuredResult.onCompleted({
                attribution,
                execution,
                result,
                userMessage,
              });
            } else if (encryptedTaskMessages?.response) {
              const encryptedResult = taskMessageRelayResultSchema.parse(
                result.structuredResult,
              );
              if (
                encryptedResult.message.id !==
                  encryptedTaskMessages.response.id ||
                encryptedResult.message.idempotencyKey !==
                  encryptedTaskMessages.response.idempotencyKey
              ) {
                throw new Error(
                  "The encrypted Task message result metadata is invalid.",
                );
              }
              if (!hasFinal(finals, result.turnId, result.text)) {
                const assistant = await appendLiveTaskMessage(
                  ownerId,
                  execution.chatId,
                  encryptedResult.message,
                  attribution,
                  execution,
                );
                if (!assistant) {
                  throw new Error("Encrypted Task Chat not found.");
                }
                await setLiveTaskMessageModelRoute(
                  ownerId,
                  assistant.id,
                  modelId,
                  runtime,
                  undefined,
                  execution,
                );
              }
            } else if (encryptedChatMessages) {
              const encryptedResult = chatMessageRelayResultSchema.parse(
                result.structuredResult,
              );
              if (
                !encryptedResult.message ||
                encryptedResult.message.id !==
                  encryptedChatMessages.response.id ||
                encryptedResult.message.idempotencyKey !==
                  encryptedChatMessages.response.idempotencyKey
              ) {
                throw new Error(
                  "The encrypted chat message result metadata is invalid.",
                );
              }
              if (!hasFinal(finals, result.turnId, result.text)) {
                const assistant = await appendLiveEncryptedChatMessage(
                  ownerId,
                  execution.chatId,
                  encryptedResult.message,
                  attribution,
                );
                if (!assistant) throw new Error("Encrypted Chat not found.");
                await setLiveEncryptedChatMessageModelRoute(
                  ownerId,
                  assistant.id,
                  modelId,
                  runtime,
                );
              }
            } else if (!hasFinal(finals, result.turnId, result.text)) {
              await appendLiveChatMessage(
                ownerId,
                execution.chatId,
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text:
                        result.text || "The agent completed without a message.",
                      phase: "final_answer",
                    },
                  ],
                  idempotencyKey: `assistant:${userMessage.id}`,
                },
                attribution,
              );
            }
            await interruptLiveAgentInteractionRequests(execution.chatId);
            const finished = await repository.finishChatExecutionLane(
              execution.chatId,
              executionLaneId,
              "idle",
            );
            publishChatTurnBoundary(
              execution.chatId,
              execution.projectId,
              execution,
            );
            if (options.structuredResult?.afterCompleted) {
              try {
                await options.structuredResult.afterCompleted({
                  attribution,
                  execution,
                  result,
                  userMessage,
                });
              } catch (error) {
                app.log.error(
                  {
                    chatId: execution.chatId,
                    err: encryptedTaskMessages
                      ? new Error("Encrypted Task post-processing failed.")
                      : error,
                  },
                  "Task post-processing failed after its structured turn completed",
                );
              }
            }
            if (options.afterTurnCompleted) {
              try {
                await options.afterTurnCompleted({
                  attribution,
                  execution,
                  result,
                  userMessage,
                });
              } catch (error) {
                app.log.error(
                  { chatId: execution.chatId, err: error },
                  "Task post-processing failed after its turn completed",
                );
              }
            }
            if (
              finished &&
              (execution.contextKind === "standalone" ||
                !(await continuePendingWorktreeTransition(execution.chatId)))
            ) {
              void dispatchNextQueuedPrompt(execution.chatId);
            }
            app.log.info(
              {
                event: "chat.turn.completed",
                subsystem: "chat-execution",
                operation: "turn",
                status: "completed",
                chatId: execution.chatId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                turnId: result.turnId,
                durationMs: Date.now() - turnStartedAtMs,
                counts: {
                  changedPaths: changedPaths.size,
                  responseCharacters: result.text.length,
                },
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
              },
              "Agent turn completed",
            );
            return;
          } catch (error) {
            const failedAt = new Date();
            const failureText = errorMessage(error).toLowerCase();
            const attemptStatus = failureText.includes("interrupt")
              ? "interrupted"
              : failureText.includes("cancel")
                ? "cancelled"
                : "failed";
            const canRetry =
              !attemptActivity &&
              canFailOverRoute(error) &&
              index < runtimes.length - 1;
            await recordRuntimeTokenUsage(
              tokenUsageSourceKey,
              execution.projectId,
              execution.chatId,
              runtime,
              undefined,
              {
                workerId: execution.workerId,
                turnId: behaviorTurnId,
                executionAttemptId,
                attemptKind: "chat-turn",
                attemptStatus,
                completedAt: failedAt,
                finalizedAt: failedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            await recordRuntimeModelBehavior(
              behaviorSourceKey,
              execution,
              runtime,
              behaviorTracker,
              {
                executionAttemptId,
                attemptStatus,
                routeAttemptIndex: index,
                retryFailoverCount: index + (canRetry ? 1 : 0),
                startedAt: attemptStartedAt,
                completedAt: failedAt,
                finalizedAt: failedAt,
                durationMs: failedAt.getTime() - attemptStartedAtMs,
                turnId: behaviorTurnId,
                userInterrupted:
                  attemptStatus === "interrupted" ||
                  attemptStatus === "cancelled",
                immediateCorrectiveFollowup,
                userRetryRegeneration: Boolean(options.retryMessageId),
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            if (!quotaFollowupsScheduled) {
              scheduleRuntimeQuotaSamples(
                runtime,
                execution,
                executionAttemptId,
                null,
              );
              quotaFollowupsScheduled = true;
            }
            if (!canRetry) throw error;
            routeCooldowns.set(
              runtimeCooldownKey(runtime),
              Date.now() + ROUTE_FAILURE_COOLDOWN_MS,
            );
            app.log.warn(
              {
                event: "chat.turn.route-failed-over",
                subsystem: "chat-execution",
                operation: "turn",
                status: "retrying",
                reasonCode: "route-failed-before-activity",
                chatId: execution.chatId,
                err: encryptedTaskMessages
                  ? new Error("Encrypted Task route failed.")
                  : error,
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                durationMs: Date.now() - attemptStartedAtMs,
                attempt: index + 1,
              },
              "Provider route failed before activity; trying the next route",
            );
          }
        }
      } catch (error: unknown) {
        if (options.structuredResult) {
          try {
            await options.structuredResult.onFailed({
              error,
              execution,
              userMessage,
            });
          } catch (taskError) {
            app.log.error(
              { chatId: execution.chatId, err: taskError },
              "Could not persist a failed Task planning operation",
            );
          }
        }
        if (execution.contextKind === "project") {
          await notifyCodeAgentState(execution, "failed", changedPaths);
        }
        if (!anyActivity && execution.modelRouteId) {
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            execution.threadId,
            execution.modelRouteId,
            "ready",
            execution.providerAccountId,
            execution.scratchRootId,
          );
        }
        const interrupted = /interrupted/i.test(errorMessage(error));
        app.log.error(
          {
            event: interrupted ? "chat.turn.interrupted" : "chat.turn.failed",
            subsystem: "chat-execution",
            operation: "turn",
            status: interrupted ? "interrupted" : "failed",
            reasonCode: interrupted ? "interrupted" : "execution-failed",
            chatId: execution.chatId,
            projectId: execution.projectId,
            workerId: execution.workerId,
            requestId: userMessage.id,
            runId: executionLaneId,
            durationMs: Date.now() - turnStartedAtMs,
            err: encryptedTaskMessages
              ? new Error("Encrypted Task turn failed.")
              : error,
          },
          "Agent turn failed",
        );
        if (!encryptedTaskMessages && !encryptedChatMessages) {
          await appendLiveChatMessage(
            ownerId,
            execution.chatId,
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: interrupted
                    ? "Turn interrupted."
                    : `Agent failed: ${errorMessage(error)}`,
                },
              ],
              idempotencyKey: `error:${userMessage.id}`,
            },
            attribution,
          );
        }
        await interruptLiveAgentInteractionRequests(execution.chatId);
        const finished = await repository.finishChatExecutionLane(
          execution.chatId,
          executionLaneId,
          interrupted || execution.contextKind === "standalone"
            ? "idle"
            : "failed",
        );
        cancelChatTurnOutcomeRecovery(
          execution.workerId,
          execution.chatId,
          userMessage.id,
        );
        publishChatTurnBoundary(
          execution.chatId,
          execution.projectId,
          execution,
        );
        if (options.afterTurnFailed) {
          try {
            await options.afterTurnFailed({ error, execution, userMessage });
          } catch (taskError) {
            app.log.error(
              { chatId: execution.chatId, err: taskError },
              "Task post-processing failed after its turn failed",
            );
          }
        }
        if (
          finished &&
          (execution.contextKind === "standalone" ||
            !(await continuePendingWorktreeTransition(execution.chatId)))
        ) {
          void dispatchNextQueuedPrompt(execution.chatId);
        }
      } finally {
        if (taskDispatchHeartbeat) clearInterval(taskDispatchHeartbeat);
      }
    });

    const firstRuntime = runtimes[0]!;
    return {
      ...userMessage,
      modelId,
      modelRouteId: firstRuntime.routeId,
      providerId: firstRuntime.provider.id,
      providerName: firstRuntime.provider.name,
      providerModelName: firstRuntime.model.name,
      reasoningEffort: requestedReasoningEffort,
      appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
      reasoningAdjusted: preparedRuntimes[0]!.adjusted,
    };
  };

  return { beginTurn };
}
