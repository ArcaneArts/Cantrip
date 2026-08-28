import { randomUUID } from "node:crypto";

import {
  chatGoalResponseSchema,
  modelConfigurationSchema,
  taskDispatchWorkerLeaseSchema,
  type AgentTurnResult,
  type ChatMessage,
  type ChatTurnCreate,
  type ModelConfiguration,
  type TaskDispatchCycleSummary,
  type TaskDispatchWorkerLease,
} from "@cantrip/protocol";
import {
  taskGoalWorkerResultSchema,
  type TaskOperationRelayGoal,
  type TaskOperationRelayResult,
  type TaskOpaqueSummary,
} from "@cantrip/protocol/tasks";
import type { FastifyInstance } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
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
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

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
  "publishChatInvalidation"
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
      beforeTurn?(): Promise<void>;
      modelConfiguration?: ModelConfiguration;
      runtimes?: ModelRuntime[];
      taskDispatchLease?: TaskDispatchWorkerLease;
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
          message: null,
        },
      }),
    );
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
    await options.beforeTurn?.();
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
        purpose: "Task implementation Goal",
        encryptedTaskMessages: {
          userMessage: objective.startMessage,
          response: {
            id: randomUUID(),
            idempotencyKey: `assistant:${objective.startMessage.id}`,
          },
        },
        workerPrompt:
          "Begin the active Task Goal and follow its encrypted objective.",
        runtimes: [runtime],
        taskDispatchLease: options.taskDispatchLease,
      },
    );
  }

  async function launchPreparedTaskGoal(
    chatId: string,
    operationId: string,
    options: Parameters<typeof startEncryptedTaskGoal>[4] = {},
  ) {
    const ownerId = applicationOwnerId();
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
  ): Promise<void> {
    await repository.tasks.failOperation(
      applicationOwnerId(),
      chatId,
      operationId,
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
    await resolvePromptAttachments(context, input.attachmentIds);
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

  const releaseTaskGoalLease = (cycleId: string) => {
    const retained = retainedTaskGoalLeases.get(cycleId);
    if (!retained) return;
    clearInterval(retained.timer);
    retainedTaskGoalLeases.delete(cycleId);
  };

  const retainTaskGoalLease = async (lease: TaskDispatchWorkerLease) => {
    const retained = retainedTaskGoalLeases.get(lease.cycleId);
    if (
      retained?.lease.fencingToken === lease.fencingToken &&
      retained.lease.leaseOwner === lease.leaseOwner
    ) {
      return;
    }
    releaseTaskGoalLease(lease.cycleId);
    await repository.taskDispatch.heartbeat(lease);
    const timer = setInterval(
      () => {
        void repository.taskDispatch.heartbeat(lease).catch((error) => {
          releaseTaskGoalLease(lease.cycleId);
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
    if (!["paused", "blocked", "complete", "failed"].includes(state)) return;
    releaseTaskGoalLease(lease.cycleId);
    try {
      await repository.taskDispatch.heartbeat(lease);
      await repository.taskDispatch.settle(
        lease,
        state === "failed" ? "failed" : "succeeded",
      );
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) throw error;
    }
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
  ) => {
    if (!context.threadId) {
      return { goal: null, message: null, task };
    }
    const runtime = await runtimeForContext(context);
    if (!runtime) throw new Error("Selected model was not found.");
    const result = taskGoalWorkerResultSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.get",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        taskContext: {
          task: taskContentFromSummary(task),
          automationPaused: context.automationPaused,
          chatStatus: context.status,
          message,
        },
      }),
    );
    if (
      result.goal?.chatId !== context.chatId ||
      (message &&
        (result.message?.id !== message.id ||
          result.message.idempotencyKey !== message.idempotencyKey))
    ) {
      throw new Error("Encrypted Goal metadata is invalid.");
    }
    const synchronized = await repository.tasks.syncImplementationState(
      applicationOwnerId(),
      context.chatId,
      { rowVersion: task.rowVersion, task: result.task },
    );
    if (synchronized && synchronized.rowVersion !== task.rowVersion) {
      publishChatInvalidation(context.chatId, "task", null, context);
    }
    const nextTask = synchronized ?? task;
    await reconcileTaskGoalDispatch(task, nextTask.state);
    return { ...result, task: nextTask };
  };

  const synchronizeScheduledTaskGoal = async (
    chatId: string,
    lease: TaskDispatchWorkerLease,
    turnFailed: boolean,
  ) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    const task = await repository.tasks.get(applicationOwnerId(), chatId);
    if (!context || context.experience !== "task" || !task) return;
    try {
      await readEncryptedTaskGoal(context, task);
    } catch (error) {
      if (!turnFailed) throw error;
      releaseTaskGoalLease(lease.cycleId);
      try {
        await repository.taskDispatch.heartbeat(lease);
        await repository.taskDispatch.settle(lease, "failed");
      } catch (dispatchError) {
        if (!(dispatchError instanceof TaskDispatchConflictError)) {
          throw dispatchError;
        }
      }
      publishChatInvalidation(chatId, "task", null, context);
      queueTaskScheduleTick();
    }
  };

  const scheduledTaskGoalTurnOptions = (lease: TaskDispatchWorkerLease) => ({
    async afterTurnCompleted({
      execution,
    }: {
      execution: ChatExecutionContext;
    }) {
      await synchronizeScheduledTaskGoal(execution.chatId, lease, false);
    },
    async afterTurnFailed({ execution }: { execution: ChatExecutionContext }) {
      await synchronizeScheduledTaskGoal(execution.chatId, lease, true);
    },
    taskDispatchLease: lease,
  });

  const resumeChatAutomation = async (chatId: string): Promise<void> => {
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
    if (await continuePendingWorktreeTransition(chatId)) return;
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
      if (context.experience === "task") {
        const task = await repository.tasks.get(
          applicationOwnerId(),
          context.chatId,
        );
        if (!task) return;
        const messageId = randomUUID();
        const idempotencyKey = `task-goal-resume:${messageId}`;
        const result = await readEncryptedTaskGoal(context, task, {
          id: messageId,
          idempotencyKey,
          kind: "resume",
        });
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
    for (const { timer } of retainedTaskGoalLeases.values()) {
      clearInterval(timer);
    }
    retainedTaskGoalLeases.clear();
  };

  return {
    close,
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    readEncryptedTaskGoal,
    reconcileTaskGoalDispatch,
    releaseTaskGoalLease,
    retainTaskGoalLease,
    resumeChatAutomation,
    scheduledTaskGoalTurnOptions,
    startGoalTurn,
    taskContentFromSummary,
    taskDispatchCycleLease,
    taskGoalDispatchLease,
  };
}
