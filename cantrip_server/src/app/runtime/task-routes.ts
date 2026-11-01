import { createTaskSchedulerRuntime } from "./task-scheduler-runtime.js";
import { createTaskResumedExecutionRuntime } from "./task-resumed-execution-runtime.js";
import { createTaskClaimedExecutionRuntime } from "./task-claimed-execution-runtime.js";
import { createTaskDispatchEligibilityRuntime } from "./task-dispatch-eligibility-runtime.js";
import {
  chatInterruptAcceptedSchema,
  chatModelConfigurationUpdateSchema,
  contextualChatWireSummarySchema,
  encryptedTaskCreateSchema,
  githubIssueListFiltersSchema,
  githubPullRequestListSchema,
  modelConfigurationFailureSchema,
  projectTaskPauseStateSchema,
  projectTaskPauseUpdateSchema,
  taskWireCreateResultSchema,
} from "@cantrip/protocol";
import { chatAttachmentOpaqueListSchema } from "@cantrip/protocol/attachment-content";
import {
  taskEncryptedOperationStartSchema,
  taskImplementationOpaqueDashboardSchema,
  taskOpaqueMutationSchema,
  taskOpaqueSummarySchema,
  taskOperationStartSchema,
  taskRecoveryStartSchema,
  type TaskAssociatedPullRequest,
  type TaskEncryptedOperationStart,
  type TaskOpaqueSummary,
  type TaskOperationRelayRequest,
  type TaskOperationStart,
} from "@cantrip/protocol/tasks";
import type { FastifyInstance, FastifyReply } from "fastify";

import { chatIsExecuting } from "../../chats/execution-helpers.js";
import {
  ExecutionLaneBusyError,
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
  type ChatExecutionContext,
  type ModelRuntime,
} from "../../db/repository.js";
import { TaskConflictError } from "../../db/tasks.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import { TaskSchedulingConflictError } from "../../db/task-scheduling.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { modelConfigurationFailure } from "../../models/subagent-routing.js";
import {
  associateTaskPullRequests,
  taskAdvisoryWarnings,
  type TaskWorktreeObservation,
} from "../../tasks/dashboard.js";
import { parseTaskOperationRelayResult } from "../../tasks/encrypted-relay.js";
import { withTaskLaunchStageTimeout } from "../../tasks/launch-observation.js";
import { TaskStateTransitionError } from "../../tasks/state.js";
import { createTaskLabeler } from "../../chats/automatic-labeling.js";
import { createTaskOperationQueue } from "./task-operation-queue.js";
import { createChatAutomationPauseRuntime } from "./chat-automation-pause-runtime.js";
import { createProjectTaskPauseRuntime } from "./project-task-pause-runtime.js";
import { installTaskWorkloadRoute } from "./task-workload-route.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import { createTaskExecutionRecovery } from "./task-execution-recovery.js";
import {
  createTaskAutomaticRetry,
  retryTaskOperation,
} from "./task-automatic-retry.js";
import { classifyTaskFailure } from "../../tasks/automatic-retry.js";

import {
  STREAMING_WORKER_COMMAND_TIMEOUT_MS,
  TASK_SCHEDULE_POLL_MS,
} from "../shared/constants.js";

export type { TaskRouteRuntimeDependencies } from "./task-route-types.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

/** Owns Task creation, dispatch scheduling, project controls, and Task routes. */
export function installTaskRouteRuntime(
  app: FastifyInstance,
  dependencies: TaskRouteRuntimeDependencies,
) {
  const {
    appendLiveTaskMessage,
    applicationOwnerId,
    availableModelRuntimes,
    beginTurn,
    bridge,
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    publishChatInvalidation,
    publishChatSummary,
    publishLiveInvalidation,
    readEncryptedTaskGoal,
    releaseTaskGoalLease,
    repository,
    resolveModelId,
    retainTaskGoalLease,
    resumeChatAutomation,
    routePairsForConfiguration,
    runAsOwner,
    runtimeForContext,
    scheduledTaskGoalTurnOptions,
    sendModelConfigurationResolutionFailure,
    serverId,
    serverInstanceId,
    taskDispatchCycleLease,
  } = dependencies;
  const nameTask = createTaskLabeler(dependencies);
  const setChatAutomationPause = createChatAutomationPauseRuntime(
    dependencies,
    app,
  );
  const taskRecovery = createTaskExecutionRecovery({
    repository,
    bridge,
    ownerId: applicationOwnerId,
    leaseOwner: `${serverId}:${serverInstanceId}`,
    goals: {
      continueTaskGoalInWorktree: dependencies.continueTaskGoalInWorktree,
      readEncryptedTaskGoal: dependencies.readEncryptedTaskGoal,
      retainTaskGoalLease,
      resumeChatAutomation,
      reconcileTaskGoalDispatch: dependencies.reconcileTaskGoalDispatch,
    },
    publish: (chatId, projectId) => {
      publishChatSummary(chatId, projectId);
      publishChatInvalidation(chatId, "task", null, {
        experience: "task",
        projectId,
      });
    },
    unpause: (ownerId, chatId) =>
      setChatAutomationPause(ownerId, chatId, false, {
        resumeAutomation: false,
      }),
    reportFailure: (chatId, error) =>
      app.log.warn(
        { chatId, err: error },
        "Could not observe a retained Task session for recovery",
      ),
  });
  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/recover",
    async (request, reply) => {
      const input = taskRecoveryStartSchema.safeParse(request.body ?? {});
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const owner = applicationOwnerId();
      const context = await repository.getChatExecutionContext(
        owner,
        request.params.chatId,
      );
      if (!context || context.experience !== "task")
        return reply.code(404).send({ error: "Task not found." });
      try {
        await repository.taskRetries.reset(owner, context.chatId);
        if (!(await taskRecovery.recover(context.chatId, true)))
          return reply.code(409).send({
            error:
              "No retained implementation session was found. Use Retry implementation from the plan to start it.",
          });
        return reply.send(
          taskOpaqueSummarySchema.parse(
            await repository.tasks.get(owner, context.chatId),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
  const setProjectTasksPaused = createProjectTaskPauseRuntime({
    repository,
    releaseTaskGoalLease,
    taskDispatchCycleLease,
    publishChatInvalidation,
    setChatAutomationPause,
    publishChatSummary,
  });
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks",
    async (request, reply) => {
      const input = encryptedTaskCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const created = await repository.createTask(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => bridge.isConnected(workerId),
        );
        if (!created) {
          return reply.code(404).send({ error: "Project source not found" });
        }
        publishChatSummary(created.chat.id, created.chat.projectId);
        nameTask(created.task);
        publishChatInvalidation(
          created.chat.id,
          "task",
          created.chat.id,
          created.chat,
        );
        return reply.code(201).send(taskWireCreateResultSchema.parse(created));
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          if (error.code === "project-not-found") {
            return reply.code(404).send({ error: "Project source not found" });
          }
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        if (
          error instanceof ExecutionLaneConflictError ||
          /unique|duplicate/i.test(errorMessage(error))
        ) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );

  async function beginEncryptedTaskOperation(
    context: ChatExecutionContext,
    input: TaskEncryptedOperationStart,
  ) {
    const ownerId = applicationOwnerId();
    const request = input.operation;
    if (request.chatId !== context.chatId) {
      throw new TaskConflictError(
        "The encrypted operation belongs to another Task.",
        "idempotency-conflict",
      );
    }
    const prior = await repository.tasks.getOperationContext(
      ownerId,
      context.chatId,
      { operationId: request.operationId },
    );
    if (prior) {
      if (prior.relayRequest.fingerprint !== request.fingerprint) {
        throw new TaskConflictError(
          "This Task operation ID was already used for different input.",
          "idempotency-conflict",
        );
      }
      return prior.task;
    }
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    if (chatIsExecuting(context.status)) {
      throw new TaskConflictError(
        "The Task already has an active Chat turn.",
        "operation-active",
      );
    }
    const started = await repository.tasks.beginOperation(
      ownerId,
      context.chatId,
      input,
    );
    if (!started) return null;
    publishChatInvalidation(context.chatId, "task", null, context);
    if (started.idempotent) return started.task;

    try {
      const userMessage = await beginTurn(
        context,
        {
          text: "Run the encrypted Task operation.",
          attachmentIds: started.task.draftAttachmentIds,
          idempotencyKey: `task-operation:${request.operationId}`,
        },
        {
          purpose: "Encrypted Task operation",
          encryptedTaskMessages: { userMessage: request.userMessage },
          structuredResult: {
            taskOperation: request,
            async onCompleted({ attribution, result }) {
              const relayResult = parseTaskOperationRelayResult(
                result.structuredResult,
                request,
              );
              const completed = await repository.tasks.completeOperation(
                ownerId,
                context.chatId,
                request.operationId,
                relayResult,
                result.turnId ?? null,
              );
              if (!completed) {
                throw new Error("Encrypted Task operation was not found.");
              }
              const assistantMessage = await appendLiveTaskMessage(
                ownerId,
                context.chatId,
                relayResult.assistantMessage,
                attribution,
                context,
              );
              if (!assistantMessage) {
                throw new Error("Task Chat was not found.");
              }
              await repository.tasks.attachOperationAssistantMessage(
                ownerId,
                context.chatId,
                request.operationId,
                assistantMessage.id,
              );
              if (request.classification.kind !== "finalize")
                await repository.taskRetries.clearPending(
                  ownerId,
                  context.chatId,
                );
              publishChatInvalidation(context.chatId, "task", null, context);
            },
            async afterCompleted() {
              if (request.classification.kind !== "finalize") return;
              try {
                await launchPreparedTaskGoal(
                  context.chatId,
                  request.operationId,
                );
              } catch (error) {
                await failTaskGoalLaunch(
                  context.chatId,
                  request.operationId,
                  error,
                );
              }
            },
            async onFailed() {
              await repository.tasks.failOperation(
                ownerId,
                context.chatId,
                request.operationId,
              );
              publishChatInvalidation(context.chatId, "task", null, context);
            },
          },
        },
      );
      if (!userMessage.executionLaneId) {
        throw new Error("Encrypted Task operation did not acquire a lane.");
      }
      await repository.tasks.attachOperationExecution(
        ownerId,
        context.chatId,
        request.operationId,
        {
          executionLaneId: userMessage.executionLaneId,
          userMessageId: userMessage.id,
        },
      );
      return (
        (await repository.tasks.get(ownerId, context.chatId)) ?? started.task
      );
    } catch (error) {
      await repository.tasks.failOperation(
        ownerId,
        context.chatId,
        request.operationId,
      );
      publishChatInvalidation(context.chatId, "task", null, context);
      throw error;
    }
  }

  const { prepareTaskDispatchEligibility, prepareTaskResumeEligibility } =
    createTaskDispatchEligibilityRuntime(dependencies, app);

  const taskScheduler = createTaskSchedulerRuntime(
    {
      ...dependencies,
      taskRecovery,
      automaticRetry: {
        tick: () => automaticRetry.tick(),
        drain: () => automaticRetry.drain(),
      },
      prepareTaskDispatchEligibility,
      prepareTaskResumeEligibility,
      runClaimedTaskOperation: (...args) => runClaimedTaskOperation(...args),
      runResumedTaskDispatch: (...args) => runResumedTaskDispatch(...args),
    },
    app,
  );
  const { queueTaskScheduleTick } = taskScheduler;

  const { runClaimedTaskOperation } = createTaskClaimedExecutionRuntime(
    { ...dependencies, queueTaskScheduleTick },
    app,
  );

  const { runResumedTaskDispatch } = createTaskResumedExecutionRuntime({
    ...dependencies,
    setChatAutomationPause,
    runClaimedTaskOperation,
  });

  const queueTaskOperation = createTaskOperationQueue({
    repository,
    applicationOwnerId,
    publishChatInvalidation,
    queueTaskScheduleTick,
    nameTask,
  });
  const automaticRetry = createTaskAutomaticRetry({
    repository,
    recover: taskRecovery.recover,
    queue: (chatId, input, kind) =>
      queueTaskOperation(chatId, input, kind, { automatic: true }),
    runAsOwner,
    observe: (context, task) =>
      readEncryptedTaskGoal(context, task, null, true, false, undefined, true),
    publish: (chatId, projectId) =>
      publishChatInvalidation(chatId, "task", null, {
        experience: "task",
        projectId,
      }),
    report: (chatId, error) =>
      app.log.warn(
        { chatId, err: error },
        "Automatic Task retry did not start; history is retained",
      ),
  });
  const taskScheduleTimer = setInterval(
    queueTaskScheduleTick,
    TASK_SCHEDULE_POLL_MS,
  );
  taskScheduleTimer.unref();
  queueTaskScheduleTick();

  installTaskWorkloadRoute(app, { applicationOwnerId, repository });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks/pause",
    async (request, reply) => {
      const state = await repository.taskScheduling.getProjectTaskPauseState(
        applicationOwnerId(),
        request.params.projectId,
      );
      return state
        ? reply.send(projectTaskPauseStateSchema.parse(state))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks/pause",
    async (request, reply) => {
      const input = projectTaskPauseUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const state = await repository.taskScheduling.setProjectTaskPauseState(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        if (!state) {
          return reply.code(404).send({ error: "Project not found." });
        }
        try {
          await setProjectTasksPaused(
            applicationOwnerId(),
            request.params.projectId,
            state.paused,
          );
        } catch (error) {
          return reply.code(409).send({
            error: errorMessage(error),
            pauseState: projectTaskPauseStateSchema.parse(state),
          });
        } finally {
          if (!state.paused) queueTaskScheduleTick();
          publishLiveInvalidation("task", {
            projectId: request.params.projectId,
          });
        }
        return reply
          .code(state.paused ? 200 : 202)
          .send(projectTaskPauseStateSchema.parse(state));
      } catch (error) {
        if (error instanceof TaskSchedulingConflictError) {
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId",
    async (request, reply) => {
      const task = await repository.tasks.get(
        applicationOwnerId(),
        request.params.chatId,
      );
      return task
        ? reply.send(taskOpaqueSummarySchema.parse(task))
        : reply.code(404).send({ error: "Task not found." });
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/dashboard",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      let task = await repository.tasks.get(ownerId, request.params.chatId);
      const context = await repository.getChatExecutionContext(
        ownerId,
        request.params.chatId,
      );
      if (
        !task ||
        !context ||
        context.contextKind !== "project" ||
        context.experience !== "task"
      ) {
        return reply.code(404).send({ error: "Task not found." });
      }
      if (
        !task.implementationStartedAt ||
        (task.planGoalEnabled && !task.hasFinalPlan)
      ) {
        return reply
          .code(409)
          .send({ error: "Task implementation has not started." });
      }

      const project = await repository.getProject(ownerId, context.projectId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const directFolder = context.rootKind === "folder-root";
      const [lanes, worktrees, githubContext] = await Promise.all([
        repository.listChatExecutionLanes(ownerId, context.chatId),
        directFolder
          ? Promise.resolve([])
          : repository.listProjectWorktrees(ownerId, context.projectId),
        directFolder
          ? Promise.resolve(null)
          : repository.getGithubProjectExecutionContext(
              ownerId,
              context.projectId,
              context.workerId,
            ),
      ]);
      const observations: TaskWorktreeObservation[] = await Promise.all(
        worktrees.map(async (worktree) => {
          const snapshot = await repository.getProjectWorktreeStatusSnapshot(
            ownerId,
            context.projectId,
            worktree.id,
          );
          return {
            dirty: Boolean(snapshot?.status.files.length),
            dirtyFileCount: snapshot?.status.files.length ?? 0,
            worktree,
          };
        }),
      );
      const activeObservation = directFolder
        ? null
        : observations.find(
            ({ worktree }) => worktree.id === context.worktreeId,
          );
      if (!directFolder && !activeObservation) {
        return reply.code(409).send({ error: "Task worktree was not found." });
      }

      let goal = null;
      let goalUnavailableReason: string | null = null;
      if (!task.planGoalEnabled) {
        goalUnavailableReason = null;
      } else if (!context.threadId) {
        goalUnavailableReason = "The Task Chat has no active Codex thread.";
      } else if (!bridge.isConnected(context.workerId)) {
        goalUnavailableReason = "The project worker is offline.";
      } else {
        try {
          const response = await readEncryptedTaskGoal(context, task);
          goal = response.goal;
          task = response.task;
          if (!goal) {
            goalUnavailableReason =
              "No Goal is attached to this session. Completion has not been confirmed. Use Retry / resume to restore the saved implementation Goal.";
          }
        } catch {
          goalUnavailableReason = "Encrypted Goal status is unavailable.";
        }
      }

      let pullRequestsUnavailableReason: string | null = null;
      let pullRequests: TaskAssociatedPullRequest[] = [];
      if (directFolder) {
        pullRequestsUnavailableReason = null;
      } else if (!githubContext) {
        pullRequestsUnavailableReason =
          "This project is not linked to a GitHub repository.";
      } else if (!bridge.isConnected(githubContext.workerId)) {
        pullRequestsUnavailableReason = "The GitHub project worker is offline.";
      } else {
        try {
          const results = await Promise.all(
            (["open", "closed"] as const).map(async (state) =>
              githubPullRequestListSchema.parse(
                await bridge.request(githubContext.workerId, {
                  type: "github.pull-requests.list",
                  repository: githubContext.nameWithOwner,
                  state,
                  cursor: null,
                  limit: 100,
                  filters: githubIssueListFiltersSchema.parse({}),
                }),
              ),
            ),
          );
          const open = results[0]!;
          const closed = results[1]!;
          pullRequests = associateTaskPullRequests({
            activeWorktreeId: context.worktreeId,
            implementationStartedAt: task.implementationStartedAt,
            lanes,
            pullRequests: [...open.pullRequests, ...closed.pullRequests],
            worktrees: observations,
          });
        } catch (error) {
          pullRequestsUnavailableReason = errorMessage(error).slice(0, 2_000);
        }
      }
      const warnings = directFolder
        ? []
        : taskAdvisoryWarnings({
            activeWorktreeId: context.worktreeId,
            lanes,
            pullRequests,
            state: task.state,
            worktrees: observations,
          });
      return reply.send(
        taskImplementationOpaqueDashboardSchema.parse({
          task,
          goal,
          goalUnavailableReason,
          placement: directFolder
            ? {
                kind: "folder",
                workerId: context.workerId,
                rootId: context.worktreeId,
                displayPath: project.source?.displayPath ?? context.cwd,
              }
            : {
                kind: "git",
                workerId: context.workerId,
                worktreeId: activeObservation!.worktree.id,
                worktreeName: activeObservation!.worktree.name,
                branch: activeObservation!.worktree.branch,
                isPrimary: activeObservation!.worktree.isPrimary,
                dirty: activeObservation!.dirty,
                dirtyFileCount: activeObservation!.dirtyFileCount,
              },
          pullRequests,
          pullRequestsUnavailableReason,
          warnings,
        }),
      );
    },
  );

  app.get<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/attachments",
    async (request, reply) => {
      const task = await repository.tasks.get(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!task) return reply.code(404).send({ error: "Task not found." });
      const attachments = await repository.getChatAttachments(
        applicationOwnerId(),
        request.params.chatId,
        task.draftAttachmentIds,
      );
      return reply.send(chatAttachmentOpaqueListSchema.parse(attachments));
    },
  );

  const taskMutationError = (
    error: unknown,
    reply: FastifyReply,
  ): FastifyReply | null => {
    if (error instanceof TaskDispatchConflictError) {
      return reply.code(409).send({ code: error.code, error: error.message });
    }
    if (error instanceof TaskConflictError) {
      return reply.code(409).send({ code: error.code, error: error.message });
    }
    if (error instanceof TaskStateTransitionError) {
      return reply
        .code(409)
        .send({ code: "invalid-state", error: error.message });
    }
    return null;
  };

  const interruptTaskForDeletion = async (
    ownerId: string,
    chatId: string,
  ): Promise<void> => {
    let context: ChatExecutionContext | null = null;
    try {
      const [resolvedContext, task] = await Promise.all([
        repository.getChatExecutionContext(ownerId, chatId),
        repository.tasks.get(ownerId, chatId),
      ]);
      context = resolvedContext;
      if (!context || !task) return;
      const dispatchState = task.dispatch?.state;
      const mayBeRunning =
        chatIsExecuting(context.status) ||
        task.state === "planning" ||
        task.state === "implementing" ||
        dispatchState === "claimed" ||
        dispatchState === "running";
      if (!mayBeRunning) return;

      if (!bridge.isConnected(context.workerId)) {
        app.log.warn(
          {
            event: "task.deletion-interrupt.skipped",
            subsystem: "task-execution",
            operation: "interrupt-before-delete",
            status: "skipped",
            reasonCode: "worker-offline",
            chatId,
            projectId: context.projectId,
            workerId: context.workerId,
          },
          "Task worker is offline; deletion will continue",
        );
        return;
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        app.log.warn(
          {
            event: "task.deletion-interrupt.skipped",
            subsystem: "task-execution",
            operation: "interrupt-before-delete",
            status: "skipped",
            reasonCode: "runtime-unavailable",
            chatId,
            projectId: context.projectId,
            workerId: context.workerId,
          },
          "Task runtime is unavailable; deletion will continue",
        );
        return;
      }
      const result = chatInterruptAcceptedSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.interrupt",
          executionProfile:
            context.contextKind === "standalone" ? "standalone-chat" : "ide",
          chatId,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
        }),
      );
      app.log.info(
        {
          event: "task.deletion-interrupt.completed",
          subsystem: "task-execution",
          operation: "interrupt-before-delete",
          status: result.interrupted ? "completed" : "not-active",
          chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        result.interrupted
          ? "Running Task interrupted before deletion"
          : "Task had no active worker turn before deletion",
      );
    } catch (error) {
      app.log.warn(
        {
          event: "task.deletion-interrupt.failed",
          subsystem: "task-execution",
          operation: "interrupt-before-delete",
          status: "failed",
          chatId,
          projectId: context?.projectId ?? null,
          workerId: context?.workerId ?? null,
          error: errorMessage(error),
        },
        "Task interruption failed; deletion will continue",
      );
    }
  };

  app.delete<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId",
    async (request, reply) => {
      try {
        const ownerId = applicationOwnerId();
        await interruptTaskForDeletion(ownerId, request.params.chatId);
        const deleted = await repository.tasks.deleteOwned(
          ownerId,
          request.params.chatId,
        );
        if (!deleted) {
          return reply.code(404).send({ error: "Task not found." });
        }
        publishChatSummary(request.params.chatId, deleted.projectId);
        publishChatInvalidation(request.params.chatId, "task", null, {
          experience: "task",
          projectId: deleted.projectId,
        });
        return reply.code(204).send();
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        throw error;
      }
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/draft",
    async (request, reply) => {
      const input = taskOpaqueMutationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const task = await repository.tasks.updateDraft(
          applicationOwnerId(),
          request.params.chatId,
          input.data,
        );
        if (!task) return reply.code(404).send({ error: "Task not found." });
        publishChatInvalidation(request.params.chatId, "task");
        return reply.send(taskOpaqueSummarySchema.parse(task));
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        throw error;
      }
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/model-configuration",
    async (request, reply) => {
      const input = chatModelConfigurationUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(context.status)) {
        return reply.code(409).send(
          modelConfigurationFailureSchema.parse({
            error:
              "Finish or interrupt the active turn before changing its model configuration.",
            code: "chat-runtime-active",
            field: null,
            retryable: true,
          }),
        );
      }
      try {
        await routePairsForConfiguration(context, input.data);
      } catch (error) {
        const response = sendModelConfigurationResolutionFailure(reply, error);
        if (response) return response;
        throw error;
      }
      const result = await repository.setChatModelConfiguration(
        applicationOwnerId(),
        request.params.chatId,
        input.data,
      );
      return result
        ? reply.send(contextualChatWireSummarySchema.parse(result))
        : reply.code(404).send({ error: "Chat or model not found." });
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/plan",
    async (request, reply) => {
      const input = taskOpaqueMutationSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const task = await repository.tasks.updatePlan(
          applicationOwnerId(),
          request.params.chatId,
          input.data,
        );
        if (!task) return reply.code(404).send({ error: "Task not found." });
        publishChatInvalidation(request.params.chatId, "task");
        return reply.send(taskOpaqueSummarySchema.parse(task));
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        throw error;
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/start",
    async (request, reply) => {
      const input = taskOperationStartSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context || context.experience !== "task") {
        return reply.code(404).send({ error: "Task not found." });
      }
      try {
        const task = await queueTaskOperation(
          request.params.chatId,
          input.data,
          "direct",
        );
        return task
          ? reply.code(202).send(taskOpaqueSummarySchema.parse(task))
          : reply.code(404).send({ error: "Task not found." });
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/plan",
    async (request, reply) => {
      const input = taskOperationStartSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context || context.experience !== "task") {
        return reply.code(404).send({ error: "Task not found." });
      }
      try {
        const task = await queueTaskOperation(
          request.params.chatId,
          input.data,
          "initial-plan",
        );
        return task
          ? reply.code(202).send(taskOpaqueSummarySchema.parse(task))
          : reply.code(404).send({ error: "Task not found." });
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/continue",
    async (request, reply) => {
      const input = taskOperationStartSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context || context.experience !== "task") {
        return reply.code(404).send({ error: "Task not found." });
      }
      try {
        const task = await queueTaskOperation(
          request.params.chatId,
          input.data,
          "continue-plan",
        );
        return task
          ? reply.code(202).send(taskOpaqueSummarySchema.parse(task))
          : reply.code(404).send({ error: "Task not found." });
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/begin-implementation",
    async (request, reply) => {
      const input = taskOperationStartSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context || context.experience !== "task") {
        return reply.code(404).send({ error: "Task not found." });
      }
      try {
        const task = await queueTaskOperation(
          request.params.chatId,
          input.data,
          "finalize",
        );
        return task
          ? reply.code(202).send(taskOpaqueSummarySchema.parse(task))
          : reply.code(404).send({ error: "Task not found." });
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId/retry",
    async (request, reply) => {
      const plainInput = taskOperationStartSchema.safeParse(request.body);
      const encryptedInput = taskEncryptedOperationStartSchema.safeParse(
        request.body,
      );
      let input: TaskOperationStart;
      let legacyOperationKind:
        TaskOperationRelayRequest["classification"]["kind"] | null = null;
      if (plainInput.success) {
        input = plainInput.data;
      } else if (encryptedInput.success) {
        input = {
          operationId: encryptedInput.data.operation.operationId,
          rowVersion: encryptedInput.data.rowVersion,
        };
        legacyOperationKind = encryptedInput.data.operation.classification.kind;
      } else {
        return reply.code(400).send(invalidBody(plainInput.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context || context.experience !== "task") {
        return reply.code(404).send({ error: "Task not found." });
      }
      const task = await repository.tasks.get(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (
        task?.state === "implementing" &&
        task.hasFinalPlan &&
        task.hasGoalPrompt
      ) {
        return reply.code(202).send(taskOpaqueSummarySchema.parse(task));
      }
      if (task?.state !== "failed" || !task.lastError) {
        return reply
          .code(409)
          .send({ error: "This Task has no failed operation to retry." });
      }
      try {
        await repository.taskRetries.reset(
          applicationOwnerId(),
          request.params.chatId,
        );
        if (task.lastError.operationKind === "implementation") {
          return reply.code(409).send({
            error:
              "Use the implementation Goal controls to resume or restart this Task.",
          });
        }
        if (
          legacyOperationKind !== null &&
          legacyOperationKind !== task.lastError.operationKind
        ) {
          return reply.code(409).send({
            error: "The encrypted retry does not match the failed operation.",
          });
        }
        const retried = await retryTaskOperation(
          repository,
          applicationOwnerId(),
          { ...task, rowVersion: input.rowVersion },
          queueTaskOperation,
          input.operationId,
        );
        return retried
          ? reply.code(202).send(taskOpaqueSummarySchema.parse(retried))
          : reply.code(404).send({ error: "Task not found." });
      } catch (error) {
        const response = taskMutationError(error, reply);
        if (response) return response;
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
  return {
    recoverTaskExecution: taskRecovery.recover,
    reconcileTaskExecutions: taskRecovery.reconcile,
    queueTaskScheduleTick,
    taskScheduleTimer,
    stopAutomaticRetries: automaticRetry.stop,
    waitForActiveTaskScheduleTick: taskScheduler.waitForActiveTaskScheduleTick,
  };
}
