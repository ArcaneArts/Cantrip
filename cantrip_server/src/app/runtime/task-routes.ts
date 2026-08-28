import {
  chatModelConfigurationUpdateSchema,
  chatPauseRuntimeStateSchema,
  contextualChatWireSummarySchema,
  encryptedTaskCreateSchema,
  githubPullRequestListSchema,
  modelConfigurationFailureSchema,
  projectTaskPauseStateSchema,
  projectTaskPauseUpdateSchema,
  projectTaskWorkloadOpaqueSchema,
  taskWireCreateResultSchema,
  terminalWireSummarySchema,
  type AgentTurnResult,
  type ChatMessage,
  type ChatTurnCreate,
  type ModelConfiguration,
  type TaskDispatchCycleSummary,
  type TaskDispatchWorkerLease,
} from "@cantrip/protocol";
import { chatAttachmentOpaqueListSchema } from "@cantrip/protocol/attachment-content";
import {
  taskEncryptedOperationStartSchema,
  taskImplementationOpaqueDashboardSchema,
  taskOpaqueMutationSchema,
  taskOpaqueSummarySchema,
  taskOperationStartSchema,
  type TaskAssociatedPullRequest,
  type TaskEncryptedOperationStart,
  type TaskGoalWorkerResult,
  type TaskMessageOpaqueContent,
  type TaskOpaqueSummary,
  type TaskOperationRelayRequest,
  type TaskOperationStart,
} from "@cantrip/protocol/tasks";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import {
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
  type ChatExecutionAttribution,
  type ChatExecutionContext,
  type ChatLiveRouting,
  type ModelRuntime,
  type ServerRepository,
} from "../../db/repository.js";
import { TaskConflictError } from "../../db/tasks.js";
import {
  TaskDispatchConflictError,
  taskDispatchSchedulerPlan,
  type ClaimedTaskDispatch,
  type TaskDispatchEligibilityResolver,
  type TaskDispatchResumeEligibilityResolver,
} from "../../db/task-dispatch.js";
import { TaskSchedulingConflictError } from "../../db/task-scheduling.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "../../http/worker-request-failures.js";
import {
  modelConfigurationFailure,
  type ResolvedModelRoutePair,
} from "../../models/subagent-routing.js";
import {
  associateTaskPullRequests,
  taskAdvisoryWarnings,
  type TaskWorktreeObservation,
} from "../../tasks/dashboard.js";
import { parseTaskOperationRelayResult } from "../../tasks/encrypted-relay.js";
import { TaskStateTransitionError } from "../../tasks/state.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import {
  STREAMING_WORKER_COMMAND_TIMEOUT_MS,
  TASK_SCHEDULE_POLL_MS,
} from "../shared/constants.js";
import type { ChatLiveResource } from "../shared/live-resources.js";

type TaskTurnInput = Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
  attachmentIds?: string[];
  customSubagentModel?: boolean;
  mode?: ChatTurnCreate["mode"];
  subagentModelId?: string | null;
  subagentReasoningEffort?: ChatExecutionContext["reasoningEffort"];
};

interface TaskTurnCallbackInput {
  attribution: ChatExecutionAttribution;
  execution: ChatExecutionContext;
  result: AgentTurnResult;
  userMessage: ChatMessage;
}

interface TaskTurnOptions {
  encryptedTaskMessages?: {
    userMessage: TaskMessageOpaqueContent;
    response?: { id: string; idempotencyKey: string };
  };
  purpose?: string;
  runtimes?: ModelRuntime[];
  structuredResult?: {
    taskOperation: TaskOperationRelayRequest;
    afterCompleted?(input: TaskTurnCallbackInput): Promise<void>;
    onCompleted(input: TaskTurnCallbackInput): Promise<void>;
    onFailed(input: {
      error: unknown;
      execution: ChatExecutionContext;
      userMessage: ChatMessage;
    }): Promise<void>;
  };
  afterTurnCompleted?(input: TaskTurnCallbackInput): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  taskDispatchLease?: TaskDispatchWorkerLease;
}

interface TaskGoalLaunchOptions {
  afterTurnCompleted?(input: TaskTurnCallbackInput): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  modelConfiguration?: ModelConfiguration;
  runtimes?: ModelRuntime[];
  taskDispatchLease?: TaskDispatchWorkerLease;
}

export interface TaskRouteRuntimeDependencies {
  appendLiveTaskMessage: (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => ReturnType<ServerRepository["appendTaskMessage"]>;
  applicationOwnerId: () => string;
  availableModelRuntimes: (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ) => Promise<ModelRuntime[]>;
  beginTurn: (
    context: ChatExecutionContext,
    input: TaskTurnInput,
    options?: TaskTurnOptions,
  ) => Promise<ChatMessage>;
  bridge: LimitedWorkerCommandBus;
  failTaskGoalLaunch: (
    chatId: string,
    operationId: string,
    error: unknown,
  ) => Promise<void>;
  launchPreparedTaskGoal: (
    chatId: string,
    operationId: string,
    options?: TaskGoalLaunchOptions,
  ) => Promise<unknown>;
  publishChatInvalidation: (
    chatId: string,
    resource: ChatLiveResource,
    entityId?: string | null,
    routing?: ChatLiveRouting,
  ) => void;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  publishLiveInvalidation: (
    resource: "task",
    input: { projectId: string },
  ) => void;
  readEncryptedTaskGoal: (
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
  ) => Promise<
    Omit<TaskGoalWorkerResult, "task"> & { task: TaskOpaqueSummary }
  >;
  releaseTaskGoalLease: (cycleId: string) => void;
  repository: ServerRepository;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  retainTaskGoalLease: (lease: TaskDispatchWorkerLease) => Promise<void>;
  resumeChatAutomation: (chatId: string) => Promise<void>;
  routePairsForConfiguration: (
    context: ChatExecutionContext,
    configuration: ModelConfiguration,
    rootRuntimes?: ModelRuntime[],
  ) => Promise<ResolvedModelRoutePair[]>;
  runAsOwner: <T>(ownerId: string, operation: () => T) => T;
  runtimeCanResumeContext: (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) => boolean;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  scheduledTaskGoalTurnOptions: (
    lease: TaskDispatchWorkerLease,
  ) => TaskGoalLaunchOptions;
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
  serverId: string;
  serverInstanceId: string;
  taskDispatchCycleLease: (
    dispatch: TaskDispatchCycleSummary | null,
  ) => TaskDispatchWorkerLease | null;
}

/** Owns Task creation, dispatch scheduling, project controls, and Task routes. */
export function installTaskRouteRuntime(
  app: FastifyInstance,
  {
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
    runtimeCanResumeContext,
    runtimeForContext,
    scheduledTaskGoalTurnOptions,
    sendModelConfigurationResolutionFailure,
    serverId,
    serverInstanceId,
    taskDispatchCycleLease,
  }: TaskRouteRuntimeDependencies,
) {
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

  const prepareTaskDispatchEligibility = async (
    ownerId: string,
  ): Promise<TaskDispatchEligibilityResolver> => {
    const [cycles, taskWorkers] = await Promise.all([
      repository.taskDispatch.list(ownerId),
      repository.taskScheduling.listTaskWorkers(ownerId),
    ]);
    const resolutions = new Map<
      string,
      {
        physicalWorkerId: string;
        projectId: string;
        resolution: Awaited<ReturnType<TaskDispatchEligibilityResolver>>;
        taskWorkerRevision: number;
        worktreeId: string;
      }
    >();
    for (const cycle of cycles) {
      if (cycle.state !== "queued") continue;
      const context = await repository.getChatExecutionContext(
        ownerId,
        cycle.chatId,
      );
      if (
        !context ||
        context.contextKind !== "project" ||
        context.experience !== "task"
      ) {
        continue;
      }
      const physicalWorker = await repository.getWorker(
        ownerId,
        context.workerId,
      );
      for (const taskWorker of taskWorkers) {
        if (!taskWorker.enabled) continue;
        const key = `${cycle.id}:${taskWorker.id}`;
        let resolution: Awaited<ReturnType<TaskDispatchEligibilityResolver>>;
        if (!bridge.isConnected(context.workerId)) {
          resolution = { eligible: false, code: "worker-offline" };
        } else if (
          !physicalWorker?.encryption.grants.some(
            ({ component }) => component === "task-content",
          )
        ) {
          resolution = {
            eligible: false,
            code: "encryption-grant-unavailable",
          };
        } else {
          try {
            const pairs = await routePairsForConfiguration(
              { ...context, providerAccountId: null },
              taskWorker.modelConfiguration,
            );
            const selected = pairs[0]?.root.runtime;
            resolution = selected
              ? {
                  eligible: true,
                  modelRouteId: selected.routeId,
                  providerAccountId: selected.provider.accountId,
                  codexThreadId:
                    context.threadId &&
                    runtimeCanResumeContext(context, selected)
                      ? context.threadId
                      : null,
                }
              : { eligible: false, code: "model-unavailable" };
          } catch (error) {
            const failure = modelConfigurationFailure(error);
            resolution = {
              eligible: false,
              code:
                failure?.code === "worker-offline"
                  ? "worker-offline"
                  : failure?.code === "provider-route-incompatible"
                    ? "provider-route-unavailable"
                    : "model-unavailable",
            };
          }
        }
        resolutions.set(key, {
          physicalWorkerId: context.workerId,
          projectId: context.projectId,
          resolution,
          taskWorkerRevision: taskWorker.rowVersion,
          worktreeId: context.worktreeId,
        });
      }
    }
    return async (input) => {
      const prepared = resolutions.get(
        `${input.cycle.id}:${input.taskWorker.id}`,
      );
      if (
        !prepared ||
        prepared.projectId !== input.projectId ||
        prepared.physicalWorkerId !== input.physicalWorkerId ||
        prepared.worktreeId !== input.worktreeId ||
        prepared.taskWorkerRevision !== input.taskWorker.rowVersion
      ) {
        return { eligible: false, code: "placement-unavailable" };
      }
      return prepared.resolution;
    };
  };

  const prepareTaskResumeEligibility = async (
    ownerId: string,
  ): Promise<TaskDispatchResumeEligibilityResolver> => {
    const cycles = await repository.taskDispatch.list(ownerId);
    const resolutions = new Map<
      string,
      Awaited<ReturnType<TaskDispatchResumeEligibilityResolver>>
    >();
    for (const cycle of cycles) {
      if (cycle.state !== "paused") continue;
      const context = await repository.getChatExecutionContext(
        ownerId,
        cycle.chatId,
      );
      if (
        !context ||
        context.experience !== "task" ||
        !cycle.selectedTaskWorkerId ||
        !cycle.modelConfiguration?.modelId ||
        !cycle.modelRouteId ||
        !cycle.physicalWorkerId ||
        !cycle.worktreeId ||
        context.workerId !== cycle.physicalWorkerId ||
        context.worktreeId !== cycle.worktreeId
      ) {
        resolutions.set(cycle.id, {
          eligible: false,
          code: "placement-unavailable",
        });
        continue;
      }
      if (!bridge.isConnected(cycle.physicalWorkerId)) {
        resolutions.set(cycle.id, {
          eligible: false,
          code: "worker-offline",
        });
        continue;
      }
      try {
        const runtimes = await availableModelRuntimes(
          {
            workerId: cycle.physicalWorkerId,
            providerAccountId: cycle.providerAccountId,
          },
          cycle.modelConfiguration.modelId,
        );
        const exact = runtimes.some(
          (runtime) =>
            runtime.routeId === cycle.modelRouteId &&
            runtime.provider.accountId === cycle.providerAccountId,
        );
        resolutions.set(
          cycle.id,
          exact
            ? { eligible: true }
            : { eligible: false, code: "provider-route-unavailable" },
        );
      } catch {
        resolutions.set(cycle.id, {
          eligible: false,
          code: "model-unavailable",
        });
      }
    }
    return async (cycle) =>
      resolutions.get(cycle.id) ?? {
        eligible: false,
        code: "placement-unavailable",
      };
  };

  let activeTaskScheduleTick: Promise<void> | null = null;
  const queueTaskScheduleTick = (): void => {
    if (activeTaskScheduleTick) return;
    activeTaskScheduleTick = (async () => {
      const schedulerOwners =
        await repository.taskDispatch.listSchedulerOwners();
      for (const schedulerOwner of schedulerOwners) {
        const ownerId = schedulerOwner.ownerId;
        const plan = taskDispatchSchedulerPlan(schedulerOwner);
        await runAsOwner(ownerId, async () => {
          const requeued = plan.reconcileUnstartedClaims
            ? await repository.taskDispatch.requeueExpiredLeases(ownerId)
            : [];
          if (requeued.length > 0) {
            app.log.warn(
              {
                event: "task.scheduler.unstarted-leases-requeued",
                subsystem: "task-scheduler",
                operation: "reconcile-leases",
                status: "requeued",
                counts: { requeued: requeued.length },
              },
              "Requeued expired Task claims that had not started",
            );
          }
          const expired = plan.reconcileStartedLeases
            ? await repository.taskDispatch.expireStartedLeases(ownerId)
            : [];
          for (const cycle of expired) {
            try {
              await repository.tasks.failOperation(
                ownerId,
                cycle.chatId,
                cycle.operationId,
              );
            } catch (error) {
              app.log.error(
                {
                  chatId: cycle.chatId,
                  cycleId: cycle.id,
                  err: error,
                  event: "task.scheduler.started-lease-reconcile-failed",
                  subsystem: "task-scheduler",
                  operation: "reconcile-leases",
                  status: "failed",
                },
                "Could not reconcile an expired started Task lease",
              );
            }
            publishChatInvalidation(cycle.chatId, "task");
          }
          if (expired.length > 0) {
            app.log.warn(
              {
                event: "task.scheduler.started-leases-expired",
                subsystem: "task-scheduler",
                operation: "reconcile-leases",
                status: "attention-required",
                counts: { expired: expired.length },
              },
              "Expired started Task leases require user attention",
            );
          }
          if (plan.resumePaused) {
            const resolveResumeEligibility =
              await prepareTaskResumeEligibility(ownerId);
            while (true) {
              const resumed = await repository.taskDispatch.resumeNextPaused(
                ownerId,
                `${serverId}:${serverInstanceId}`,
                resolveResumeEligibility,
              );
              if (!resumed) break;
              void runResumedTaskDispatch(ownerId, resumed).catch((error) => {
                app.log.error(
                  {
                    chatId: resumed.cycle.chatId,
                    cycleId: resumed.cycle.id,
                    err: error,
                  },
                  "Paused Task resume failed",
                );
              });
            }
          }
          if (plan.claimQueued || requeued.length > 0) {
            const resolveEligibility =
              await prepareTaskDispatchEligibility(ownerId);
            while (true) {
              const claimed = await repository.taskDispatch.claimNext(
                ownerId,
                `${serverId}:${serverInstanceId}`,
                resolveEligibility,
              );
              if (!claimed) break;
              void runClaimedTaskOperation(ownerId, claimed).catch((error) => {
                app.log.error(
                  {
                    chatId: claimed.cycle.chatId,
                    cycleId: claimed.cycle.id,
                    err: error,
                  },
                  "Scheduled Task execution failed",
                );
              });
            }
          }
        });
      }
    })()
      .catch((error) => {
        app.log.error({ err: error }, "Could not schedule queued Tasks");
      })
      .finally(() => {
        activeTaskScheduleTick = null;
      });
  };

  const finishClaimedTaskFailure = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
  ): Promise<void> => {
    try {
      await repository.taskDispatch.heartbeat(claim.lease);
      const operation = await repository.tasks.getOperationContext(
        ownerId,
        claim.cycle.chatId,
        { operationId: claim.cycle.operationId },
      );
      if (operation?.relayResult) {
        await repository.taskDispatch.settle(claim.lease, "succeeded");
      } else {
        if (operation) {
          await repository.tasks.failOperation(
            ownerId,
            claim.cycle.chatId,
            claim.cycle.operationId,
          );
        }
        await repository.taskDispatch.settle(claim.lease, "failed");
      }
      publishChatInvalidation(claim.cycle.chatId, "task", null, {
        experience: "task",
        projectId: claim.projectId,
      });
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) throw error;
    } finally {
      queueTaskScheduleTick();
    }
  };

  const runClaimedTaskOperation = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
  ): Promise<void> => {
    await runAsOwner(ownerId, async () => {
      const context = await repository.getChatExecutionContext(
        ownerId,
        claim.cycle.chatId,
      );
      try {
        if (
          !context ||
          context.experience !== "task" ||
          context.projectId !== claim.projectId ||
          context.workerId !== claim.cycle.physicalWorkerId ||
          context.worktreeId !== claim.cycle.worktreeId
        ) {
          throw new Error("The claimed Task placement is no longer available.");
        }
        if (
          claim.cycle.operationKind === "goal-continuation" ||
          !claim.cycle.modelRouteId ||
          !claim.cycle.modelConfiguration?.modelId
        ) {
          throw new Error("The claimed Task cycle is not executable yet.");
        }
        const taskModelId = claim.cycle.modelConfiguration.modelId;
        const task = await repository.tasks.get(ownerId, context.chatId);
        if (!task) throw new Error("The claimed Task no longer exists.");

        const prior = await repository.tasks.getOperationContext(
          ownerId,
          context.chatId,
          { operationId: claim.cycle.operationId },
        );
        const configuredRuntimes = await availableModelRuntimes(
          {
            workerId: context.workerId,
            providerAccountId: claim.cycle.providerAccountId,
          },
          taskModelId,
        );
        const runtime = configuredRuntimes.find(
          (candidate) =>
            candidate.routeId === claim.cycle.modelRouteId &&
            candidate.provider.accountId === claim.cycle.providerAccountId,
        );
        if (!runtime) {
          throw new Error(
            "The claimed Task model route is no longer available.",
          );
        }

        const launchClaimedGoal = async (operationId: string) => {
          try {
            await retainTaskGoalLease(claim.lease);
            const goalTurnOptions = scheduledTaskGoalTurnOptions(claim.lease);
            await launchPreparedTaskGoal(context.chatId, operationId, {
              ...goalTurnOptions,
              modelConfiguration: claim.cycle.modelConfiguration!,
              runtimes: [runtime],
            });
          } catch (error) {
            releaseTaskGoalLease(claim.lease.cycleId);
            try {
              await failTaskGoalLaunch(context.chatId, operationId, error);
            } finally {
              try {
                await repository.taskDispatch.heartbeat(claim.lease);
                await repository.taskDispatch.settle(claim.lease, "failed");
              } catch (dispatchError) {
                if (!(dispatchError instanceof TaskDispatchConflictError)) {
                  throw dispatchError;
                }
              }
              publishChatInvalidation(context.chatId, "task", null, context);
              queueTaskScheduleTick();
            }
          }
        };
        if (prior?.relayResult) {
          if (prior.round.kind === "finalize") {
            await launchClaimedGoal(prior.round.id);
          } else {
            await repository.taskDispatch.heartbeat(claim.lease);
            await repository.taskDispatch.settle(claim.lease, "succeeded");
            publishChatInvalidation(context.chatId, "task", null, context);
            queueTaskScheduleTick();
          }
          return;
        }

        let request: TaskOperationRelayRequest;
        let startedTask: TaskOpaqueSummary;
        if (prior) {
          request = prior.relayRequest;
          startedTask = prior.task;
        } else {
          const prepared = taskEncryptedOperationStartSchema.parse(
            await bridge.request(context.workerId, {
              type: "task.operation.prepare",
              operationId: claim.cycle.operationId,
              operationKind: claim.cycle.operationKind,
              task,
            }),
          );
          const started = await repository.tasks.beginOperation(
            ownerId,
            context.chatId,
            prepared,
          );
          if (!started) throw new Error("The claimed Task no longer exists.");
          request = started.relayRequest;
          startedTask = started.task;
          publishChatInvalidation(context.chatId, "task", null, context);
        }

        const userMessage = await beginTurn(
          context,
          {
            text: "Run the encrypted Task operation.",
            attachmentIds: startedTask.draftAttachmentIds,
            idempotencyKey: `task-operation:${request.operationId}`,
            modelId: taskModelId,
            reasoningEffort: claim.cycle.modelConfiguration.reasoningEffort,
            customSubagentModel:
              claim.cycle.modelConfiguration.customSubagentModel,
            subagentModelId: claim.cycle.modelConfiguration.subagentModelId,
            subagentReasoningEffort:
              claim.cycle.modelConfiguration.subagentReasoningEffort,
          },
          {
            purpose: "Scheduled encrypted Task operation",
            encryptedTaskMessages: { userMessage: request.userMessage },
            runtimes: [runtime],
            taskDispatchLease: claim.lease,
            structuredResult: {
              taskOperation: request,
              async onCompleted({ attribution, result }) {
                await repository.taskDispatch.heartbeat(claim.lease);
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
                if (request.classification.kind !== "finalize") {
                  await repository.taskDispatch.settle(
                    claim.lease,
                    "succeeded",
                  );
                  queueTaskScheduleTick();
                }
                publishChatInvalidation(context.chatId, "task", null, context);
              },
              async afterCompleted() {
                if (request.classification.kind !== "finalize") return;
                await launchClaimedGoal(request.operationId);
              },
              async onFailed() {
                await finishClaimedTaskFailure(ownerId, claim);
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
      } catch (error) {
        app.log.warn(
          {
            chatId: claim.cycle.chatId,
            cycleId: claim.cycle.id,
            err: error,
          },
          "Scheduled Task operation failed to start",
        );
        await finishClaimedTaskFailure(ownerId, claim);
      }
    });
  };

  const runResumedTaskDispatch = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
  ): Promise<void> => {
    await runAsOwner(ownerId, async () => {
      const context = await repository.getChatExecutionContext(
        ownerId,
        claim.cycle.chatId,
      );
      try {
        if (
          !context ||
          context.experience !== "task" ||
          context.projectId !== claim.projectId ||
          context.workerId !== claim.cycle.physicalWorkerId ||
          context.worktreeId !== claim.cycle.worktreeId
        ) {
          throw new Error("The paused Task placement is no longer available.");
        }
        const resumed = chatPauseRuntimeStateSchema.parse(
          await bridge.request(
            context.workerId,
            { type: "chat.pause.set", chatId: context.chatId, paused: false },
            { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
          ),
        );
        if (resumed.paused) {
          throw new Error("The worker did not resume the paused Task.");
        }
        if (resumed.active) {
          if (
            (claim.cycle.codexThreadId &&
              resumed.active.threadId !== claim.cycle.codexThreadId) ||
            (claim.cycle.turnId && resumed.active.turnId !== claim.cycle.turnId)
          ) {
            throw new Error("The paused Task runtime affinity changed.");
          }
        } else {
          const task = await repository.tasks.get(ownerId, context.chatId);
          if (
            claim.cycle.operationKind === "finalize" &&
            task?.state === "implementing"
          ) {
            await retainTaskGoalLease(claim.lease);
            await resumeChatAutomation(context.chatId);
          } else {
            await runClaimedTaskOperation(ownerId, claim);
          }
        }
        if (claim.cycle.operationKind === "finalize") {
          await retainTaskGoalLease(claim.lease);
        }
        publishChatInvalidation(context.chatId, "task", null, context);
      } catch (error) {
        if (context && bridge.isConnected(context.workerId)) {
          await bridge
            .request(
              context.workerId,
              { type: "chat.pause.set", chatId: context.chatId, paused: true },
              { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
            )
            .catch(() => undefined);
        }
        try {
          await repository.taskDispatch.pause(claim.lease, {
            threadId: claim.cycle.codexThreadId,
            turnId: claim.cycle.turnId,
          });
        } catch (dispatchError) {
          if (!(dispatchError instanceof TaskDispatchConflictError)) {
            throw dispatchError;
          }
        }
        publishChatInvalidation(
          claim.cycle.chatId,
          "task",
          null,
          context ?? undefined,
        );
        throw error;
      }
    });
  };

  const taskScheduleTimer = setInterval(
    queueTaskScheduleTick,
    TASK_SCHEDULE_POLL_MS,
  );
  taskScheduleTimer.unref();
  queueTaskScheduleTick();

  const queueTaskOperation = async (
    chatId: string,
    input: TaskOperationStart,
    operationKind: "direct" | "initial-plan" | "continue-plan" | "finalize",
  ): Promise<TaskOpaqueSummary | null> => {
    const ownerId = applicationOwnerId();
    await repository.taskDispatch.enqueue(
      ownerId,
      chatId,
      input.operationId,
      operationKind,
      input.rowVersion,
    );
    publishChatInvalidation(chatId, "task");
    queueTaskScheduleTick();
    return repository.tasks.get(ownerId, chatId);
  };

  const pauseProjectTaskDispatches = async (
    ownerId: string,
    projectId: string,
  ): Promise<void> => {
    const cycles = (await repository.taskDispatch.list(ownerId)).filter(
      (cycle) => cycle.state === "claimed" || cycle.state === "running",
    );
    const scoped = (
      await Promise.all(
        cycles.map(async (cycle) => ({
          cycle,
          context: await repository.getChatExecutionContext(
            ownerId,
            cycle.chatId,
          ),
        })),
      )
    ).filter(({ context }) => context?.projectId === projectId);
    const results = await Promise.allSettled(
      scoped.map(async ({ context, cycle }) => {
        if (!context || context.experience !== "task") return;
        const lease = taskDispatchCycleLease(cycle);
        if (!lease) return;
        if (!bridge.isConnected(context.workerId)) {
          throw new Error("A running Task's physical Worker is offline.");
        }
        const paused = chatPauseRuntimeStateSchema.parse(
          await bridge.request(
            context.workerId,
            { type: "chat.pause.set", chatId: context.chatId, paused: true },
            { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
          ),
        );
        if (!paused.paused) {
          throw new Error("The worker did not acknowledge the Task pause.");
        }
        releaseTaskGoalLease(cycle.id);
        try {
          await repository.taskDispatch.pause(lease, {
            threadId:
              paused.active?.threadId ??
              cycle.codexThreadId ??
              context.threadId,
            turnId: paused.active?.turnId ?? cycle.turnId,
          });
          publishChatInvalidation(context.chatId, "task", null, context);
        } catch (error) {
          if (!(error instanceof TaskDispatchConflictError)) throw error;
        }
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} running Task${failures.length === 1 ? "" : "s"} could not pause at a safe boundary.`,
      );
    }
  };

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks/workload",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const tasks = await repository.tasks.list(
        ownerId,
        request.params.projectId,
      );
      const project = await repository.getProject(
        ownerId,
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const items = await Promise.all(
        tasks.map(async (task) => {
          const [plan, messagePage] = await Promise.all([
            repository.getChatPlanWireState(ownerId, task.chatId),
            repository.listTaskMessagePage(ownerId, task.chatId, {
              limit: 100,
            }),
          ]);
          if (!plan) {
            throw new Error("Task Chat plan state was not found.");
          }
          return { task, plan, messages: messagePage.messages };
        }),
      );
      return reply.send(
        projectTaskWorkloadOpaqueSchema.parse({
          projectId: request.params.projectId,
          items,
        }),
      );
    },
  );

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
        if (state.paused) {
          try {
            await pauseProjectTaskDispatches(
              applicationOwnerId(),
              request.params.projectId,
            );
          } catch (error) {
            return reply.code(409).send({
              error: errorMessage(error),
              pauseState: projectTaskPauseStateSchema.parse(state),
            });
          }
        } else {
          queueTaskScheduleTick();
        }
        publishLiveInvalidation("task", {
          projectId: request.params.projectId,
        });
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
            goalUnavailableReason = "Codex no longer reports an active Goal.";
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
                  page: 1,
                  limit: 100,
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

  app.delete<{ Params: { chatId: string } }>(
    "/api/tasks/:chatId",
    async (request, reply) => {
      try {
        const deleted = await repository.tasks.deleteDraft(
          applicationOwnerId(),
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
        if (task.lastError.operationKind === "finalize") {
          const rounds = await repository.tasks.listRounds(
            applicationOwnerId(),
            request.params.chatId,
          );
          const latest = rounds.find(
            (round) => round.ordinal === task.planningRound,
          );
          const prepared = latest
            ? await repository.tasks.getOperationContext(
                applicationOwnerId(),
                request.params.chatId,
                { operationId: latest.id },
              )
            : null;
          if (prepared?.relayResult?.goal) {
            const retried = await queueTaskOperation(
              request.params.chatId,
              { operationId: latest.id, rowVersion: input.rowVersion },
              "finalize",
            );
            return retried
              ? reply.code(202).send(taskOpaqueSummarySchema.parse(retried))
              : reply.code(404).send({ error: "Task not found." });
          }
        }
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
        const retried = await queueTaskOperation(
          request.params.chatId,
          input,
          task.lastError.operationKind,
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
    queueTaskScheduleTick,
    taskScheduleTimer,
    waitForActiveTaskScheduleTick: () => activeTaskScheduleTick,
  };
}
