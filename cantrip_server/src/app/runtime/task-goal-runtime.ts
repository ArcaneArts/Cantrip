import { protectChatInput } from "./protect-chat-input.js";
import {
  managedConsoleSessionContext,
  prepareManagedConsoleLaunch,
} from "../../terminals/managed-session.js";
import { toChatAttachmentOpaqueSummary } from "../../db/repository.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  chatGoalResponseSchema,
  modelConfigurationSchema,
  taskDispatchWorkerLeaseSchema,
  nativeGoalRecoveryReceiptSchema,
  type NativeGoalRecovery,
  type NativeGoalClaimRecovery,
  nativeGoalClaimRecoveryReceiptSchema,
  type TaskGoalCycleRecovery,
  taskGoalCycleRecoveryReceiptSchema,
  type AgentTurnResult,
  type ChatMessage,
  type ChatTurnCreate,
  type ModelConfiguration,
  type TaskDispatchCycleSummary,
  type TaskDispatchWorkerLease,
  type TaskDispatchFence,
  type TaskInferenceInputReceipt,
} from "@cantrip/protocol";
import {
  taskGoalWorkerResultSchema,
  taskMessageOpaqueContentSchema,
  type TaskOperationRelayGoal,
  type TaskOperationRelayResult,
  type TaskOpaqueSummary,
  type TaskOpaqueContent,
  type TaskMessageOpaqueContent,
  type TaskGoalWorkerResult,
  type TaskGoalSyncContext,
} from "@cantrip/protocol/tasks";
import { classifyTaskFailure } from "../../tasks/automatic-retry.js";
import { TaskConflictError } from "../../db/tasks.js";
import type { TaskGoalObservationFence } from "../../db/task-goal-observations.js";
import type { FastifyInstance } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
  taskGoalWorkerInterrupted,
} from "../../chats/execution-helpers.js";
import {
  TASK_DISPATCH_LEASE_MS,
  TaskDispatchConflictError,
} from "../../db/task-dispatch.js";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import { GOAL_RESUME_PROMPT } from "../shared/constants.js";
import type { createChatRecoveryRuntime } from "./chat-recovery-runtime.js";
import type { BeginChatTurn } from "./chat-turn-runtime.js";
import type {
  TaskOperationDispatchFence,
  TaskOperationLeaseFence,
} from "../../db/task-operation-fence.js";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

export type TaskGoalReadResult = Omit<TaskGoalWorkerResult, "task"> & {
  task: TaskOpaqueSummary;
  /** Private server read scope; HTTP responses select only public fields. */
  observationFence?: TaskGoalObservationFence;
};

type ChatRecoveryRuntime = ReturnType<typeof createChatRecoveryRuntime>;
type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;

interface TaskGoalRecoveryDependencies extends Pick<
  ChatRecoveryRuntime,
  | "continuePendingWorktreeTransition"
  | "dispatchNextQueuedPrompt"
  | "resolvePromptAttachments"
> {}

interface TaskGoalLiveMutationDependencies extends Pick<
  LiveMutationRuntime,
  | "publishChatInvalidation"
  | "appendLiveEncryptedChatMessage"
  | "taskMessageServerStub"
> {}

interface TaskGoalModelRoutingDependencies extends Pick<
  ModelRoutingRuntime,
  | "resolveModelId"
  | "routePairsForConfiguration"
  | "runtimeCanResumeContext"
  | "runtimeForContext"
> {}

export interface TaskGoalRuntimeDependencies
  extends
    TaskGoalRecoveryDependencies,
    TaskGoalLiveMutationDependencies,
    TaskGoalModelRoutingDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  beginTurn: BeginChatTurn;
  bridge: LimitedWorkerCommandBus;
  queueTaskScheduleTick: () => void;
  repository: ServerRepository;
}

class TaskGoalLaunchError extends Error {
  constructor(readonly failureTask: TaskOpaqueContent) {
    super(
      failureTask.classification.lastError?.code ?? "Task Goal startup failed.",
    );
  }
}

/**
 * Owns interactive and scheduled Goal execution, encrypted Task Goal
 * synchronization, and retained dispatch-lease lifecycle.
 */
export function createTaskGoalRuntime({
  app,
  applicationOwnerId,
  beginTurn,
  bridge,
  continuePendingWorktreeTransition,
  dispatchNextQueuedPrompt,
  publishChatInvalidation,
  appendLiveEncryptedChatMessage,
  taskMessageServerStub,
  queueTaskScheduleTick,
  repository,
  resolveModelId,
  resolvePromptAttachments,
  routePairsForConfiguration,
  runtimeCanResumeContext,
  runtimeForContext,
}: TaskGoalRuntimeDependencies) {
  async function startEncryptedTaskGoal(
    context: ChatExecutionContext,
    objective: TaskOperationRelayGoal,
    task: TaskOperationRelayResult["task"],
    idempotencyKey: string,
    options: {
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
      beforeTurn?(result: TaskGoalWorkerResult): Promise<void>;
      modelConfiguration?: ModelConfiguration;
      runtimes?: ModelRuntime[];
      taskDispatchLease?: TaskDispatchWorkerLease;
      userMessage?: TaskMessageOpaqueContent;
      workerPrompt?: string;
      purpose?: string;
      messageRole?: "system" | "user";
      goalControlMessage?: TaskGoalSyncContext["message"];
    } = {},
  ): Promise<void> {
    const modelId = await resolveModelId(
      context,
      options.modelConfiguration?.modelId ?? undefined,
    );
    const modelConfiguration = modelConfigurationSchema.parse({
      ...(options.modelConfiguration ?? context.modelConfiguration),
      modelId,
    });
    const routePairs = await routePairsForConfiguration(
      context,
      modelConfiguration,
      options.runtimes,
    );
    const runtime = routePairs[0]!.root.runtime;
    const result = taskGoalWorkerResultSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.create",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: runtimeCanResumeContext(context, runtime)
          ? context.threadId
          : null,
        objective,
        tokenBudget: null,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        taskContext: {
          task,
          automationPaused: context.automationPaused,
          chatStatus: context.status,
          message: options.goalControlMessage ?? null,
        },
      }),
    );
    const failureCode = result.task.classification.lastError?.code ?? "";
    if (
      !result.goal &&
      (/^task-goal-start-(failed|timeout|capacity|rate-limit|connection|needs-input|configuration|usage-limit|budget-limit)$/.test(
        failureCode,
      ) ||
        (options.goalControlMessage?.kind === "resume" &&
          /^implementation-(runtime|timeout|capacity|rate-limit|connection|needs-input|configuration|usage-limit|budget-limit)-failed$/.test(
            failureCode,
          )))
    ) {
      throw new TaskGoalLaunchError(result.task);
    }
    if (result.goal?.chatId !== context.chatId) {
      throw new Error("The encrypted Goal belongs to another Task.");
    }
    if (!result.goal) throw new Error("Codex did not create the Task Goal.");
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      result.goal.threadId,
      runtime.routeId,
      "ready",
      runtime.provider.accountId,
    );
    const updated = await repository.getChatExecutionContext(
      applicationOwnerId(),
      context.chatId,
    );
    if (!updated) throw new Error("Task Chat source not found.");
    await options.beforeTurn?.(result);
    await beginTurn(
      updated,
      {
        text: "Begin the active encrypted Task Goal.",
        mode: "goal",
        modelId,
        reasoningEffort: modelConfiguration.reasoningEffort,
        customSubagentModel: modelConfiguration.customSubagentModel,
        subagentModelId: modelConfiguration.subagentModelId,
        subagentReasoningEffort: modelConfiguration.subagentReasoningEffort,
        idempotencyKey,
      },
      {
        afterTurnCompleted: options.afterTurnCompleted,
        afterTurnFailed: options.afterTurnFailed,
        purpose: options.purpose ?? "Task implementation Goal",
        messageRole: options.messageRole,
        encryptedTaskMessages: {
          userMessage: options.userMessage ?? objective.startMessage,
          response: {
            id: randomUUID(),
            idempotencyKey: `assistant:${options.userMessage?.id ?? objective.startMessage.id}`,
          },
        },
        workerPrompt:
          options.workerPrompt ??
          "Begin the active Task Goal and follow its encrypted objective.",
        runtimes: [runtime],
        taskDispatchLease: options.taskDispatchLease,
      },
    );
  }

  async function resumePendingTaskGoalInput(
    context: ChatExecutionContext,
    lease: TaskDispatchWorkerLease,
    options: Parameters<typeof startEncryptedTaskGoal>[4] = {},
  ): Promise<boolean> {
    const pending = await repository.tasks.inferenceInputs.goals.pending(
      applicationOwnerId(),
      context.chatId,
      lease.cycleId,
    );
    if (!pending?.deferred) return false;
    const configuration =
      options.modelConfiguration ?? context.modelConfiguration;
    const modelId = await resolveModelId(
      context,
      configuration.modelId ?? undefined,
    );
    await retainTaskGoalLease(lease);
    const task = await repository.tasks.get(
      applicationOwnerId(),
      context.chatId,
    );
    if (!task) throw new Error("Task Chat source not found.");
    // Restore paused Goal state without resetting its objective. The worker's
    // inference-only activation leaves the first input to this canonical owner.
    await readEncryptedTaskGoal(
      context,
      task,
      null,
      false,
      true,
      undefined,
      false,
      { kind: "leased", lease },
    );
    await beginTurn(
      context,
      {
        ...configuration,
        modelId,
        text: "Resume the accepted Task Goal input.",
        mode: "goal",
        idempotencyKey: pending.message.idempotencyKey,
      },
      {
        ...scheduledTaskGoalTurnOptions(lease),
        ...(options.afterTurnCompleted
          ? { afterTurnCompleted: options.afterTurnCompleted }
          : {}),
        ...(options.afterTurnFailed
          ? { afterTurnFailed: options.afterTurnFailed }
          : {}),
        runtimes: options.runtimes,
        acquiringActor: "agent",
        purpose: "Resume queued Task Goal input",
        messageRole:
          pending.message.classification.role === "system" ? "system" : "user",
        encryptedTaskMessages: {
          userMessage: pending.message,
          response: {
            id: randomUUID(),
            idempotencyKey: `assistant:${pending.message.id}`,
          },
        },
        workerPrompt: GOAL_RESUME_PROMPT,
      },
    );
    return true;
  }

  async function launchPreparedTaskGoal(
    chatId: string,
    operationId: string,
    options: Parameters<typeof startEncryptedTaskGoal>[4] = {},
  ) {
    const ownerId = applicationOwnerId();
    const launchGuard = options.taskDispatchLease
      ? await repository.tasks.inferenceInputs.goals.launchGuard(
          ownerId,
          chatId,
          options.taskDispatchLease,
        )
      : undefined;
    const taskOperation = await repository.tasks.getOperationContext(
      ownerId,
      chatId,
      { operationId },
    );
    if (
      !taskOperation ||
      taskOperation.round.kind !== "finalize" ||
      !taskOperation.relayResult?.goal
    ) {
      throw new Error("The finalized Task objective is not available.");
    }
    if (options.taskDispatchLease) {
      const context = await repository.getChatExecutionContext(ownerId, chatId);
      if (
        context &&
        (await resumePendingTaskGoalInput(
          context,
          options.taskDispatchLease,
          options,
        ))
      )
        return (await repository.tasks.get(ownerId, chatId))!;
    }
    const goalStartKey = `task-goal:${operationId}`;
    const existingMessage = await repository.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      goalStartKey,
    );
    let completed: Awaited<
      ReturnType<typeof repository.tasks.completeFinalizationOperation>
    > = null;
    const completeFinalization = async () => {
      completed = await repository.tasks.completeFinalizationOperation(
        ownerId,
        chatId,
        operationId,
        launchGuard,
      );
      if (!completed) throw new Error("Task finalization was not found.");
      publishChatInvalidation(chatId, "task");
    };
    if (!existingMessage) {
      const context = await repository.getChatExecutionContext(ownerId, chatId);
      if (!context || context.experience !== "task") {
        throw new Error("Task Chat source not found.");
      }
      await startEncryptedTaskGoal(
        context,
        taskOperation.relayResult.goal,
        taskOperation.relayResult.task,
        goalStartKey,
        { ...options, beforeTurn: completeFinalization },
      );
    } else {
      await completeFinalization();
    }
    if (!completed) {
      completed = await repository.tasks.getOperationContext(ownerId, chatId, {
        operationId,
      });
    }
    if (!completed) throw new Error("Task finalization was not found.");
    return completed.task;
  }

  async function failTaskGoalLaunch(
    chatId: string,
    operationId: string,
    error: unknown,
    guard?: TaskOperationLeaseFence,
  ): Promise<void> {
    await repository.tasks.failOperation(
      applicationOwnerId(),
      chatId,
      operationId,
      error instanceof TaskGoalLaunchError ? error.failureTask : undefined,
      guard,
    );
    app.log.warn(
      {
        event: "task.goal.start-failed",
        subsystem: "task-scheduler",
        operation: "start-goal",
        status: "failed",
        reasonCode: "task-goal-start-failed",
        chatId,
        operationId,
      },
      "Task Goal startup failed; the finalized plan is retained for retry",
    );
    publishChatInvalidation(chatId, "task");
  }

  async function startGoalTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
    options: {
      idempotencyKey?: string;
      purpose?: string;
      tokenBudget?: number | null;
    } = {},
  ) {
    if (!input.text) throw new Error("Goal mode needs a text objective.");
    const attachments = await resolvePromptAttachments(
      context,
      input.attachmentIds,
    );
    const modelId = await resolveModelId(context, input.modelId);
    const requestedReasoningEffort =
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : context.reasoningEffort;
    const routePairs = await routePairsForConfiguration(
      context,
      modelConfigurationSchema.parse({
        ...context.modelConfiguration,
        modelId,
        reasoningEffort: requestedReasoningEffort,
      }),
    );
    const runtime = routePairs[0]!.root.runtime;
    if (managedConsoleSessionContext(context)) {
      const configuredContext = {
        ...context,
        reasoningEffort: requestedReasoningEffort,
        modelConfiguration: modelConfigurationSchema.parse({
          ...context.modelConfiguration,
          modelId,
          reasoningEffort: requestedReasoningEffort,
        }),
      };
      const managed = await prepareManagedConsoleLaunch(
        configuredContext,
        runtime,
        {
          ownerId: applicationOwnerId(),
          bridge,
          repository,
          routePairsForConfiguration,
        },
      );
      const idempotencyKey = options.idempotencyKey ?? input.idempotencyKey;
      let appended = await repository.getEncryptedMessageByIdempotencyKey(
        applicationOwnerId(),
        context.chatId,
        idempotencyKey,
      );
      if (!appended) {
        const protectedInput = await protectChatInput(
          bridge,
          context.workerId,
          { ...input, mode: "goal", idempotencyKey },
          attachments.map(toChatAttachmentOpaqueSummary),
          requestedReasoningEffort,
        );
        appended = await appendLiveEncryptedChatMessage(
          applicationOwnerId(),
          context.chatId,
          protectedInput,
        );
      }
      if (!appended) throw new Error("Encrypted Chat not found.");
      const operationId = `gui-goal:${appended.id}`;
      const previous = await repository.nativeCommands.lookup(
        applicationOwnerId(),
        context.workerId,
        operationId,
      );
      if (previous && previous.status !== "applied")
        throw new Error(
          `The native goal command is ${previous.status}; its saved operation cannot be replayed.`,
        );
      const result = chatGoalResponseSchema.parse(
        await bridge.request(
          context.workerId,
          previous
            ? {
                type: "chat.goal.get",
                chatId: context.chatId,
                cwd: context.cwd,
                threadId: managed.threadId!,
                model: managed.model,
                provider: managed.provider,
                permissionProfileId:
                  effectivePermissionProfile(context).effectiveId,
              }
            : {
                ...managed,
                type: "chat.goal.create",
                operationId,
                chatId: context.chatId,
                cwd: context.cwd,
                permissionProfileId:
                  effectivePermissionProfile(context).effectiveId,
                objective: input.text,
                tokenBudget: options.tokenBudget ?? null,
              },
        ),
      );
      if (!result.goal) throw new Error("Codex did not create the goal.");
      publishChatInvalidation(context.chatId, "chat-goal", null, context);
      return { goal: result, message: taskMessageServerStub(appended) };
    }

    const result = chatGoalResponseSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.create",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: runtimeCanResumeContext(context, runtime)
          ? context.threadId
          : null,
        objective: input.text,
        tokenBudget: options.tokenBudget ?? null,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
      }),
    );
    if (!result.goal) throw new Error("Codex did not create the goal.");
    publishChatInvalidation(context.chatId, "chat-goal", null, context);
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      result.goal.threadId,
      runtime.routeId,
      "ready",
      runtime.provider.accountId,
    );
    const updatedContext = await repository.getChatExecutionContext(
      applicationOwnerId(),
      context.chatId,
    );
    if (!updatedContext) throw new Error("Chat source not found.");
    const message = await beginTurn(
      updatedContext,
      {
        ...input,
        idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
        modelId,
        mode: "goal",
      },
      { purpose: options.purpose ?? "Codex goal", runtimes: [runtime] },
    );
    return { goal: result, message };
  }

  async function beginGoalTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    return (await startGoalTurn(context, input)).message;
  }

  function beginPromptTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    return input.mode === "goal"
      ? beginGoalTurn(context, input)
      : beginTurn(context, input);
  }

  const taskContentFromSummary = (task: TaskOpaqueSummary) => ({
    classification: {
      state: task.state,
      stableStateBeforeFailure: task.stableStateBeforeFailure,
      activeOperationKind: task.activeOperationKind,
      planAuthorship: task.planAuthorship,
      planningRound: task.planningRound,
      hasPlan: task.hasPlan,
      hasQuestions: task.hasQuestions,
      hasFinalPlan: task.hasFinalPlan,
      hasGoalPrompt: task.hasGoalPrompt,
      lastError: task.lastError,
    },
    protectedContent: task.protectedContent,
  });

  const retainedTaskGoalLeases = new Map<
    string,
    { lease: TaskDispatchWorkerLease; timer: ReturnType<typeof setInterval> }
  >();
  let closing = false;

  const taskDispatchCycleLease = (
    dispatch: TaskDispatchCycleSummary | null,
  ): TaskDispatchWorkerLease | null => {
    if (
      !dispatch ||
      !["claimed", "running"].includes(dispatch.state) ||
      !dispatch.leaseOwner ||
      !dispatch.leaseExpiresAt
    ) {
      return null;
    }
    return taskDispatchWorkerLeaseSchema.parse({
      cycleId: dispatch.id,
      operationId: dispatch.operationId,
      leaseOwner: dispatch.leaseOwner,
      leaseExpiresAt: dispatch.leaseExpiresAt,
      fencingToken: dispatch.fencingToken,
    });
  };

  const taskGoalDispatchLease = (
    task: TaskOpaqueSummary,
  ): TaskDispatchWorkerLease | null =>
    task.dispatch?.operationKind === "finalize"
      ? taskDispatchCycleLease(task.dispatch)
      : null;

  const releaseTaskGoalLease = (
    cycleId: string,
    expected?: TaskDispatchFence,
  ) => {
    const retained = retainedTaskGoalLeases.get(cycleId);
    if (!retained) return;
    if (
      expected &&
      (retained.lease.fencingToken !== expected.fencingToken ||
        retained.lease.leaseOwner !== expected.leaseOwner)
    )
      return;
    clearInterval(retained.timer);
    retainedTaskGoalLeases.delete(cycleId);
  };

  const retainTaskGoalLease = async (lease: TaskDispatchWorkerLease) => {
    if (closing)
      throw new Error(
        "The server is shutting down; Task recovery will continue after restart.",
      );
    const retained = retainedTaskGoalLeases.get(lease.cycleId);
    if (
      retained?.lease.fencingToken === lease.fencingToken &&
      retained.lease.leaseOwner === lease.leaseOwner
    ) {
      return;
    }
    await repository.taskDispatch.heartbeat(lease);
    if (closing)
      throw new Error(
        "The server is shutting down; Task recovery will continue after restart.",
      );
    const current = retainedTaskGoalLeases.get(lease.cycleId);
    if (current) {
      if (
        current.lease.fencingToken > lease.fencingToken ||
        (current.lease.fencingToken === lease.fencingToken &&
          current.lease.leaseOwner !== lease.leaseOwner)
      )
        throw new TaskDispatchConflictError(
          "Task Goal retention was replaced.",
          "stale-lease",
        );
      if (
        current.lease.fencingToken === lease.fencingToken &&
        current.lease.leaseOwner === lease.leaseOwner
      )
        return;
      releaseTaskGoalLease(lease.cycleId, current.lease);
    }
    const timer = setInterval(
      () => {
        void repository.taskDispatch.heartbeat(lease).catch((error) => {
          releaseTaskGoalLease(lease.cycleId, lease);
          if (!(error instanceof TaskDispatchConflictError)) {
            app.log.warn(
              { cycleId: lease.cycleId, err: error },
              "Could not retain the Task Goal dispatch lease",
            );
          }
        });
      },
      Math.floor(TASK_DISPATCH_LEASE_MS / 3),
    );
    timer.unref();
    retainedTaskGoalLeases.set(lease.cycleId, { lease, timer });
  };

  const reconcileTaskGoalDispatch = async (
    source: TaskOpaqueSummary,
    state: TaskOpaqueSummary["state"],
  ) => {
    const lease = taskGoalDispatchLease(source);
    if (!lease) return;
    if (state === "implementing") {
      await retainTaskGoalLease(lease);
      return;
    }
    if (state === "paused") {
      // A paused Goal is resumable work, not a successful dispatch. Project
      // pause has already released capacity; an individual Chat pause keeps
      // its running dispatch leased until that Chat is resumed.
      await retainTaskGoalLease(lease);
      return;
    }
    if (!["blocked", "complete", "failed"].includes(state)) return;
    // A controlled handoff is unfinished implementation, not a blocked Task's
    // successful dispatch. Keep its capacity until the destination is admitted.
    if (
      state !== "complete" &&
      (await repository.getPendingChatWorktreeTransition(
        applicationOwnerId(),
        source.chatId,
      ))
    ) {
      await retainTaskGoalLease(lease);
      return;
    }
    try {
      await repository.taskDispatch.heartbeat(lease);
      await repository.taskDispatch.settle(
        lease,
        state === "failed" ? "failed" : "succeeded",
      );
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) throw error;
    }
    releaseTaskGoalLease(lease.cycleId, lease);
    publishChatInvalidation(source.chatId, "task");
    queueTaskScheduleTick();
  };

  const readEncryptedTaskGoal = async (
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
    message: {
      id: string;
      idempotencyKey: string;
      kind: "resume" | "start";
    } | null = null,
    observeExecution = false,
    activateGoal = false,
    runtimeFailure?: TaskGoalSyncContext["runtimeFailure"],
    observationOnly = false,
    dispatchFence?: TaskOperationDispatchFence,
  ): Promise<TaskGoalReadResult> => {
    if (!context.threadId) {
      return { goal: null, message: null, task, observationFence: undefined };
    }
    const runtime = await runtimeForContext(context);
    if (!runtime) throw new Error("Selected model was not found.");
    const observation =
      !dispatchFence && !activateGoal && !message
        ? await repository.tasks.goalObservations.capture(
            applicationOwnerId(),
            context,
            task,
          )
        : undefined;
    const result = taskGoalWorkerResultSchema.parse(
      await bridge.request(context.workerId, {
        ...(activateGoal
          ? { type: "chat.goal.update" as const, status: "active" as const }
          : { type: "chat.goal.get" as const, observeExecution }),
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        ...(!activateGoal && context.osExecution
          ? { osExecution: context.osExecution }
          : {}),
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        taskContext: {
          ...(runtimeFailure ? { runtimeFailure } : {}),
          task: taskContentFromSummary(task),
          automationPaused: context.automationPaused,
          chatStatus: context.status,
          message,
        },
      }),
    );
    if (
      (result.goal &&
        (result.goal.chatId !== context.chatId ||
          result.goal.threadId !== context.threadId)) ||
      (result.execution && result.execution.threadId !== context.threadId) ||
      (result.goal &&
        message &&
        (result.message?.id !== message.id ||
          result.message.idempotencyKey !== message.idempotencyKey))
    ) {
      throw new Error("Encrypted Goal metadata is invalid.");
    }
    if (
      dispatchFence?.kind === "outcome" &&
      observeExecution &&
      !result.execution
    )
      throw new Error("Task Goal execution observation was not returned.");
    // No native Goal is a valid observation (e.g. an older handoff lost it),
    // not corrupt ciphertext and not evidence that this Task completed.
    if ((!result.goal && !runtimeFailure) || observationOnly) {
      if (observation)
        await repository.tasks.goalObservations.validate(
          applicationOwnerId(),
          context.chatId,
          observation,
        );
      return { ...result, task, observationFence: observation };
    }
    // A native observation and the Task it projected are one result. Never
    // pair stale native state with a separately refreshed Task after a CAS loss.
    const synchronized = await repository.tasks.syncImplementationState(
      applicationOwnerId(),
      context.chatId,
      { rowVersion: task.rowVersion, task: result.task },
      dispatchFence,
      observation,
    );
    if (synchronized && synchronized.rowVersion !== task.rowVersion) {
      publishChatInvalidation(context.chatId, "task", null, context);
    }
    const nextTask = { ...(synchronized ?? task), dispatch: task.dispatch };
    if (!observeExecution)
      await reconcileTaskGoalDispatch(task, nextTask.state);
    return {
      ...result,
      task: nextTask,
      observationFence: observation
        ? repository.tasks.goalObservations.afterProjection(
            observation,
            nextTask.rowVersion,
          )
        : undefined,
    };
  };

  const synchronizeScheduledTaskGoal = async (
    chatId: string,
    lease: TaskDispatchFence,
    turnFailed: boolean,
    turnError?: unknown,
    receipt?: TaskInferenceInputReceipt,
  ) => {
    if (receipt) {
      const pending = await repository.tasks.inferenceInputs.goals.terminal(
        applicationOwnerId(),
        chatId,
        receipt,
      );
      if (!pending) return; // A live transport failure is not a native terminal receipt.
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      const task = await repository.tasks.get(applicationOwnerId(), chatId);
      if (
        !context ||
        context.experience !== "task" ||
        !task ||
        (pending.terminal.threadId &&
          pending.terminal.threadId !== context.threadId)
      )
        return;
      try {
        // Read actual native lifecycle. An older dispatched turn's failure must
        // not relabel a Goal that has since continued. A proven unforwarded
        // input alone can carry its precise startup failure into this read.
        const failure =
          pending.failedBeforeDispatch && pending.terminal.failureKind
            ? {
                kind: pending.terminal.failureKind,
                occurredAt: pending.terminal.observedAt,
              }
            : undefined;
        const observed = await readEncryptedTaskGoal(
          context,
          task,
          null,
          true,
          false,
          failure,
          false,
          pending.guard,
        );
        if (!observed.goal && !(failure && observed.task.state === "failed"))
          return;
        const state =
          await repository.tasks.inferenceInputs.goals.finishProjection(
            applicationOwnerId(),
            receipt,
            observed.task.rowVersion,
            pending.guard.goalProjection,
            observed.execution,
          );
        const control = pending.guard.goalProjection.control;
        if (["complete", "blocked", "failed", "paused"].includes(state)) {
          if (control.leaseOwner)
            releaseTaskGoalLease(lease.cycleId, {
              ...receipt.dispatch,
              fencingToken: control.fencingToken,
              leaseOwner: control.leaseOwner,
            });
        } else await reconcileTaskGoalDispatch(task, state);
        publishChatInvalidation(chatId, "task", null, context);
        publishChatInvalidation(chatId, "agent-interaction", null, context);
        queueTaskScheduleTick();
      } catch (error) {
        if (
          error instanceof TaskDispatchConflictError ||
          (error instanceof TaskConflictError && error.code === "stale-version")
        )
          return;
        // The input's terminal marker remains on its canonical dispatch for
        // recovery. A metadata/transport failure cannot settle inference again.
        throw error;
      }
      return;
    }
    const guard: TaskOperationLeaseFence = {
      kind: "leased",
      lease,
    };
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    const task = await repository.tasks.get(applicationOwnerId(), chatId);
    if (!context || context.experience !== "task" || !task) return;
    if (
      context.automationPaused &&
      taskGoalWorkerInterrupted(context.experience, "goal", turnError)
    ) {
      try {
        await repository.taskDispatch.pause(lease, {
          threadId: context.threadId,
          turnId: null,
        });
        releaseTaskGoalLease(lease.cycleId, lease);
      } catch (error) {
        if (error instanceof TaskDispatchConflictError) return;
        throw error;
      }
      publishChatInvalidation(chatId, "task", null, context);
      queueTaskScheduleTick();
      return;
    }
    try {
      const failure = turnFailed
        ? {
            kind: classifyTaskFailure(turnError),
            occurredAt: new Date().toISOString(),
          }
        : undefined;
      const observed = await readEncryptedTaskGoal(
        context,
        task,
        null,
        false,
        false,
        failure,
        false,
        guard,
      );
      if (failure && observed.task.state === "failed") {
        await repository.taskRetries.noteFailure(
          applicationOwnerId(),
          chatId,
          `goal:${context.threadId}:${failure.occurredAt}`,
          classifyTaskFailure(observed.task.lastError?.code ?? failure.kind),
          undefined,
          guard,
        );
        publishChatInvalidation(chatId, "task", null, context);
      } else if (["complete", "blocked"].includes(observed.task.state)) {
        await repository.taskRetries.clearPending(
          applicationOwnerId(),
          chatId,
          guard,
        );
        publishChatInvalidation(chatId, "task", null, context);
      }
    } catch (error) {
      if (error instanceof TaskDispatchConflictError) return;
      if (!turnFailed) throw error;
      try {
        await repository.taskRetries.settleDispatchFailure(
          applicationOwnerId(),
          chatId,
          lease,
          classifyTaskFailure(turnError ?? error),
          undefined,
          guard,
        );
      } catch (failure) {
        if (failure instanceof TaskDispatchConflictError) return;
        throw failure;
      }
      releaseTaskGoalLease(lease.cycleId, lease);
      publishChatInvalidation(chatId, "task", null, context);
      queueTaskScheduleTick();
    }
  };

  const scheduledTaskGoalTurnOptions = (lease: TaskDispatchWorkerLease) => ({
    async afterTurnCompleted({
      execution,
      userMessage,
    }: {
      execution: ChatExecutionContext;
      userMessage: ChatMessage;
    }) {
      const receipt =
        await repository.tasks.inferenceInputs.goals.receiptForTurn(
          applicationOwnerId(),
          execution.chatId,
          lease,
          {
            clientMessageId: userMessage.id,
            executionLaneId: execution.executionLaneId!,
            executionLaneActivatedAt:
              execution.executionLaneActivatedAt ?? undefined,
          },
        );
      if (receipt)
        await synchronizeScheduledTaskGoal(
          execution.chatId,
          lease,
          false,
          undefined,
          receipt,
        );
    },
    async afterTurnFailed({
      execution,
      error,
      userMessage,
    }: {
      execution: ChatExecutionContext;
      error: unknown;
      userMessage: ChatMessage;
    }) {
      const receipt =
        await repository.tasks.inferenceInputs.goals.receiptForTurn(
          applicationOwnerId(),
          execution.chatId,
          lease,
          {
            clientMessageId: userMessage.id,
            executionLaneId: execution.executionLaneId!,
            executionLaneActivatedAt:
              execution.executionLaneActivatedAt ?? undefined,
          },
        );
      if (receipt)
        await synchronizeScheduledTaskGoal(
          execution.chatId,
          lease,
          true,
          error,
          receipt,
        );
    },
    taskDispatchLease: lease,
  });

  const recoverTaskGoalCycle = async (
    chatId: string,
    recovery: TaskGoalCycleRecovery,
  ): Promise<void> => {
    const ownerId = applicationOwnerId();
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    const task = await repository.tasks.get(ownerId, chatId);
    const current = await repository.tasks.inferenceInputs.goalCycles.pending(
      ownerId,
      chatId,
    );
    if (
      !context ||
      context.experience !== "task" ||
      !task?.dispatch ||
      context.threadId !== recovery.threadId ||
      current?.sourceKey !== recovery.sourceKey
    )
      return;
    // Reuse the Task's observation/CAS and retained control lease; none of this
    // grants a provider slot or creates another Goal input.
    const observation = await readEncryptedTaskGoal(
      context,
      task,
      null,
      true,
      false,
      undefined,
      true,
    );
    if (!observation.observationFence)
      throw new Error(
        "Task Goal recovery requires its native observation scope.",
      );
    const lease = await repository.taskDispatch.recoverStartedGoal(
      ownerId,
      task.dispatch,
      continuationLeaseOwner,
      new Date(),
      {
        allowSettled: true,
        assertObservation: (tx) =>
          repository.tasks.goalObservations.assertInTransaction(
            tx,
            ownerId,
            chatId,
            observation.observationFence!,
          ),
      },
    );
    await retainTaskGoalLease(lease);
    const runtime = await runtimeForContext(context);
    if (!runtime)
      throw new Error("Selected Task Goal recovery model was not found.");
    const prepared = await prepareManagedConsoleLaunch(context, runtime, {
      ownerId,
      bridge,
      repository,
      routePairsForConfiguration,
    });
    if (
      prepared.model.routeId !== recovery.cycle.modelRouteId ||
      prepared.provider.id !== recovery.providerId ||
      (prepared.provider.accountId ?? null) !== recovery.cycle.providerAccountId
    )
      throw new Error("The Task Goal recovery route changed.");
    const command = {
      type: "task.goal.recover" as const,
      ...(context.osExecution ? { osExecution: context.osExecution } : {}),
      chatId,
      projectId: context.projectId!,
      worktreeId: context.worktreeId!,
      rootKind: context.rootKind!,
      computerUseEnabled: context.computerUseEnabled === true,
      cwd: context.cwd,
      threadId: recovery.threadId,
      recovery: current,
      model: prepared.model,
      provider: prepared.provider,
      subagentDefaults: prepared.subagentDefaults ?? null,
      mcpServers: prepared.mcpServers ?? [],
      planMode: prepared.planMode ?? ("default" as const),
      permissionProfileId: effectivePermissionProfile(context).effectiveId,
    };
    const receipt = taskGoalCycleRecoveryReceiptSchema.parse(
      await bridge.request(context.workerId, command, {
        ownerId,
        timeoutMs: 10_000,
      }),
    );
    const connection = bridge.connectionIdentity(context.workerId);
    if (
      receipt.sourceKey !== current.sourceKey ||
      connection?.ownerId !== ownerId ||
      connection.workerProcessGeneration !== receipt.workerGeneration
    )
      throw new Error(
        "Task Goal recovery belongs to a replaced worker connection.",
      );
    const retired =
      await repository.tasks.inferenceInputs.goalCycles.confirmRecovery(
        ownerId,
        chatId,
        current,
        receipt,
      );
    if (retired) {
      publishChatInvalidation(chatId, "task");
      const latestContext = await repository.getChatExecutionContext(
        ownerId,
        chatId,
      );
      const latestTask = await repository.tasks.get(ownerId, chatId);
      if (
        latestContext?.experience === "task" &&
        latestTask &&
        latestContext.threadId === current.threadId
      ) {
        const projected = await readEncryptedTaskGoal(
          latestContext,
          latestTask,
          null,
          true,
        );
        await reconcileTaskGoalDispatch(projected.task, projected.task.state);
      }
      queueTaskScheduleTick();
    }
  };

  const recoverManagedGoalClaim = async (
    chatId: string,
    claim: NativeGoalClaimRecovery,
  ): Promise<void> => {
    const ownerId = applicationOwnerId();
    const current = await repository.managedQueue.goalClaimRecovery(
      ownerId,
      chatId,
    );
    if (!isDeepStrictEqual(current, claim)) return;
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (
      !context ||
      context.experience !== "agent" ||
      context.threadId !== claim.threadId
    )
      throw new Error("The Goal first-cycle recovery placement changed.");
    const runtime = await runtimeForContext(context);
    if (!runtime)
      throw new Error("Selected Goal recovery model was not found.");
    const managed = await prepareManagedConsoleLaunch(context, runtime, {
      ownerId,
      bridge,
      repository,
      routePairsForConfiguration,
    });
    const result = nativeGoalClaimRecoveryReceiptSchema.parse(
      await bridge.request(
        context.workerId,
        {
          ...managed,
          type: "chat.goal.claim-recover",
          claim,
          chatId,
          cwd: context.cwd,
          threadId: managed.threadId!,
          session: managed.session!,
          subagentDefaults: managed.subagentDefaults ?? null,
          mcpServers: managed.mcpServers ?? [],
          planMode: managed.planMode ?? "default",
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        },
        { ownerId, timeoutMs: 10_000 },
      ),
    );
    const generation =
      result.status === "queued"
        ? result.admission.workerGeneration
        : result.workerGeneration;
    const connection = bridge.connectionIdentity(context.workerId);
    if (
      !isDeepStrictEqual(result.claim, claim) ||
      connection?.ownerId !== ownerId ||
      connection.workerProcessGeneration !== generation
    )
      throw new Error(
        "Goal claim recovery belongs to a replaced worker connection.",
      );
    await repository.managedQueue.confirmGoalClaimRecovery(
      ownerId,
      chatId,
      result,
    );
    if (
      (result.status === "deferred" || result.status === "ineligible") &&
      isDeepStrictEqual(
        await repository.managedQueue.goalClaimRecovery(ownerId, chatId),
        claim,
      )
    )
      throw new Error("The applied Goal's first cycle remains unconfirmed.");
  };

  const recoverManagedGoal = async (
    chatId: string,
    recovery: NativeGoalRecovery,
  ): Promise<void> => {
    const ownerId = applicationOwnerId();
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (
      !context ||
      context.experience !== "agent" ||
      context.threadId !== recovery.source.threadId
    )
      throw new Error("The Goal recovery placement changed.");
    const snapshot = await repository.managedQueue.snapshot(ownerId, chatId);
    if (
      !isDeepStrictEqual(snapshot.goalRecovery?.source, recovery.source) ||
      snapshot.paused
    )
      return;
    const runtime = await runtimeForContext(context);
    if (!runtime)
      throw new Error("Selected Goal recovery model was not found.");
    const managed = await prepareManagedConsoleLaunch(context, runtime, {
      ownerId,
      bridge,
      repository,
      routePairsForConfiguration,
    });
    const result = nativeGoalRecoveryReceiptSchema.parse(
      await bridge.request(
        context.workerId,
        {
          ...managed,
          type: "chat.goal.recover",
          source: recovery.source,
          recovery: snapshot.goalRecovery!,
          chatId,
          cwd: context.cwd,
          threadId: managed.threadId!,
          session: managed.session!,
          subagentDefaults: managed.subagentDefaults ?? null,
          mcpServers: managed.mcpServers ?? [],
          planMode: managed.planMode ?? "default",
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        },
        { ownerId, timeoutMs: 10_000 },
      ),
    );
    const generation =
      result.status === "admitted"
        ? result.admission.workerGeneration
        : result.workerGeneration;
    const connection = bridge.connectionIdentity(context.workerId);
    if (
      !isDeepStrictEqual(result.source, recovery.source) ||
      connection?.ownerId !== ownerId ||
      connection.workerProcessGeneration !== generation
    )
      throw new Error("Goal recovery belongs to a replaced worker connection.");
    await repository.managedQueue.confirmGoalRecovery(ownerId, chatId, result);
  };

  const resumeChatAutomation = async (
    chatId: string,
    activateGoal = false,
    worktreeReconciled = false,
  ): Promise<void> => {
    let context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status) ||
      !bridge.isConnected(context.workerId)
    ) {
      return;
    }
    if (
      !worktreeReconciled &&
      (await continuePendingWorktreeTransition(chatId))
    )
      return;
    context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status)
    ) {
      return;
    }
    if (context.threadId) {
      const runtime = await runtimeForContext(context);
      if (!runtime) throw new Error("Selected model was not found.");
      if (managedConsoleSessionContext(context)) {
        const managed = await prepareManagedConsoleLaunch(context, runtime, {
          ownerId: applicationOwnerId(),
          bridge,
          repository,
          routePairsForConfiguration,
        });
        const result = (await bridge.request(context.workerId, {
          ...managed,
          type: "chat.automation.resume",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: managed.threadId!,
          session: managed.session!,
          subagentDefaults: managed.subagentDefaults ?? null,
          mcpServers: managed.mcpServers ?? [],
          planMode: managed.planMode ?? "default",
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        })) as { resumed?: unknown };
        if (typeof result?.resumed !== "boolean")
          throw new Error("The native automation resume receipt is invalid.");
        if (!result.resumed) await dispatchNextQueuedPrompt(chatId);
        return;
      }
      if (context.experience === "task") {
        const task = await repository.tasks.get(
          applicationOwnerId(),
          context.chatId,
        );
        if (!task) return;
        const pending = await repository.tasks.inferenceInputs.goals.pending(
          applicationOwnerId(),
          context.chatId,
        );
        if (pending) {
          const lease = taskGoalDispatchLease(task);
          if (lease)
            await resumePendingTaskGoalInput(context, lease, {
              runtimes: [runtime],
              modelConfiguration:
                task.dispatch?.modelConfiguration ?? undefined,
            });
          return;
        }
        const messageId = randomUUID();
        const idempotencyKey = `task-goal-resume:${messageId}`;
        const result = await readEncryptedTaskGoal(
          context,
          task,
          {
            id: messageId,
            idempotencyKey,
            kind: "resume",
          },
          false,
          activateGoal,
        );
        if (result.goal?.status === "active" && result.message) {
          const dispatchLease = taskGoalDispatchLease(task);
          if (dispatchLease) await retainTaskGoalLease(dispatchLease);
          const dispatchConfiguration = task.dispatch?.modelConfiguration;
          const modelId =
            dispatchConfiguration?.modelId ?? (await resolveModelId(context));
          await beginTurn(
            context,
            {
              text: "Resume the active encrypted Task Goal.",
              mode: "goal",
              modelId,
              reasoningEffort: dispatchConfiguration?.reasoningEffort,
              customSubagentModel: dispatchConfiguration?.customSubagentModel,
              subagentModelId: dispatchConfiguration?.subagentModelId,
              subagentReasoningEffort:
                dispatchConfiguration?.subagentReasoningEffort,
              idempotencyKey,
            },
            {
              acquiringActor: "agent",
              encryptedTaskMessages: {
                userMessage: result.message,
                response: {
                  id: randomUUID(),
                  idempotencyKey: `assistant:${result.message.id}`,
                },
              },
              purpose: "Resume encrypted Task Goal",
              runtimes: [runtime],
              workerPrompt: GOAL_RESUME_PROMPT,
              ...(dispatchLease
                ? scheduledTaskGoalTurnOptions(dispatchLease)
                : {}),
            },
          );
          return;
        }
        return;
      }
      const result = chatGoalResponseSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.goal.get",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        }),
      );
      if (result.goal?.status === "active") {
        const modelId = await resolveModelId(context);
        await beginTurn(
          context,
          {
            text: `Resume goal: ${result.goal.objective}`,
            mode: "goal",
            modelId,
            idempotencyKey: `chat-resume:${result.goal.updatedAt}:${randomUUID()}`,
          },
          {
            acquiringActor: "agent",
            purpose: "Resume paused Codex goal",
            runtimes: [runtime],
            workerPrompt: GOAL_RESUME_PROMPT,
          },
        );
        return;
      }
    }
    await dispatchNextQueuedPrompt(chatId);
  };

  const close = (): void => {
    closing = true;
    for (const { timer } of retainedTaskGoalLeases.values()) {
      clearInterval(timer);
    }
    retainedTaskGoalLeases.clear();
  };

  const continuationLeaseOwner = `task-goal-continuation:${randomUUID()}`;
  async function continueTaskGoalInWorktree(
    context: ChatExecutionContext,
    input: { text: string; idempotencyKey: string },
    retainedLease?: TaskDispatchWorkerLease,
  ): Promise<boolean> {
    const owner = applicationOwnerId();
    const task = await repository.tasks.get(owner, context.chatId);
    if (!task?.planGoalEnabled || !task.implementationStartedAt) return false;
    if (task.state === "complete") return true;
    if (context.automationPaused) throw new Error("The Task is paused.");
    const dispatch = task.dispatch;
    if (!dispatch)
      throw new Error("The Task implementation dispatch is unavailable.");
    const operation = await repository.tasks.getOperationContext(
      owner,
      context.chatId,
      { operationId: dispatch.operationId },
    );
    if (operation?.round.kind !== "finalize" || !operation.relayResult?.goal)
      throw new Error("The saved approved Task Goal is unavailable.");
    // The original encrypted finalizer result is the canonical objective. Do
    // not infer completion from prose or downgrade this to an ordinary turn.
    const lease =
      retainedLease ??
      taskGoalDispatchLease(task) ??
      (await repository.taskDispatch.recoverStartedGoal(
        owner,
        dispatch,
        continuationLeaseOwner,
        new Date(),
        { allowSettled: true },
      ));
    await retainTaskGoalLease(lease);
    const guard = await repository.tasks.inferenceInputs.goals.launchGuard(
      owner,
      context.chatId,
      lease,
    );
    try {
      const protectedMessage = await protectChatInput(
        bridge,
        context.workerId,
        { ...input, mode: "goal" },
        [],
        context.reasoningEffort,
        "system",
      );
      const userMessage = taskMessageOpaqueContentSchema.parse(
        await bridge.request(context.workerId, {
          type: "task.message.protect",
          message: protectedMessage,
        }),
      );
      const controlMessageId = randomUUID();
      await startEncryptedTaskGoal(
        { ...context, status: "idle" },
        operation.relayResult.goal,
        taskContentFromSummary(task),
        input.idempotencyKey,
        {
          ...scheduledTaskGoalTurnOptions(lease),
          userMessage,
          messageRole: "system",
          goalControlMessage: {
            kind: "resume",
            id: controlMessageId,
            idempotencyKey: `task-goal-resume:${controlMessageId}`,
          },
          modelConfiguration: dispatch.modelConfiguration ?? undefined,
          purpose: "Continue encrypted Task Goal in worktree",
          workerPrompt: `${input.text}\n\n${GOAL_RESUME_PROMPT}`,
          beforeTurn: async (result) => {
            const latest = await repository.tasks.get(owner, context.chatId);
            if (
              !latest ||
              latest.dispatch?.id !== dispatch.id ||
              latest.activeOperationKind !== null ||
              latest.state === "complete"
            )
              throw new Error(
                "The Task changed during Goal continuation. Please retry.",
              );
            await repository.tasks.syncImplementationState(
              owner,
              context.chatId,
              { rowVersion: latest.rowVersion, task: result.task },
              guard,
            );
            publishChatInvalidation(context.chatId, "task");
          },
        },
      );
      return true;
    } catch (error) {
      if (error instanceof TaskDispatchConflictError) return true;
      try {
        if (error instanceof TaskGoalLaunchError) {
          await repository.tasks.syncImplementationState(
            owner,
            context.chatId,
            {
              rowVersion: task.rowVersion,
              task: error.failureTask,
            },
            guard,
          );
          publishChatInvalidation(context.chatId, "task");
        }
        await repository.tasks.inferenceInputs.goals.settleLaunchFailure(
          owner,
          context.chatId,
          guard,
        );
      } catch (failure) {
        if (failure instanceof TaskDispatchConflictError) return true;
        throw failure;
      }
      releaseTaskGoalLease(lease.cycleId, lease);
      queueTaskScheduleTick();
      throw error;
    }
  }

  return {
    close,
    continueTaskGoalInWorktree,
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    readEncryptedTaskGoal,
    reconcileTaskGoalDispatch,
    releaseTaskGoalLease,
    retainTaskGoalLease,
    resumeChatAutomation,
    recoverManagedGoal,
    recoverManagedGoalClaim,
    recoverTaskGoalCycle,
    scheduledTaskGoalTurnOptions,
    synchronizeScheduledTaskGoal,
    startGoalTurn,
    taskContentFromSummary,
    taskDispatchCycleLease,
    taskGoalDispatchLease,
  };
}
