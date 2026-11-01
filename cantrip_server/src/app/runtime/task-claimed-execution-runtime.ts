// Actual interactive server scheduling implementation, also exercised by the
// Rust differential corpus. The extracted function body retains Source order.
import type { FastifyInstance } from "fastify";
import {
  taskEncryptedOperationStartSchema,
  type TaskOpaqueSummary,
  type TaskOperationRelayRequest,
} from "@cantrip/protocol/tasks";
import { cantripVersion } from "@cantrip/version";
import {
  ExecutionLaneBusyError,
  type ModelRuntime,
} from "../../db/repository.js";
import {
  TaskDispatchConflictError,
  type ClaimedTaskDispatch,
} from "../../db/task-dispatch.js";
import { classifyTaskFailure } from "../../tasks/automatic-retry.js";
import { parseTaskOperationRelayResult } from "../../tasks/encrypted-relay.js";
import { withTaskDispatchLeaseRetention } from "../../tasks/dispatch-lease-retention.js";
import {
  observeTaskLaunchStage,
  type TaskLaunchStage,
} from "../../tasks/launch-observation.js";
import { TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS as DEFAULT_TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS } from "../shared/constants.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

export type TaskClaimedExecutionDependencies = Pick<
  TaskRouteRuntimeDependencies,
  | "appendLiveTaskMessage"
  | "availableModelRuntimes"
  | "beginTurn"
  | "bridge"
  | "failTaskGoalLaunch"
  | "launchPreparedTaskGoal"
  | "publishChatInvalidation"
  | "releaseTaskGoalLease"
  | "repository"
  | "retainTaskGoalLease"
  | "runAsOwner"
  | "scheduledTaskGoalTurnOptions"
> & { queueTaskScheduleTick: () => void; launchPreflightTimeoutMs?: number };
export function createTaskClaimedExecutionRuntime(
  dependencies: TaskClaimedExecutionDependencies,
  app: Pick<FastifyInstance, "log">,
) {
  const {
    appendLiveTaskMessage,
    availableModelRuntimes,
    beginTurn,
    bridge,
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    publishChatInvalidation,
    releaseTaskGoalLease,
    repository,
    retainTaskGoalLease,
    runAsOwner,
    scheduledTaskGoalTurnOptions,
    queueTaskScheduleTick,
  } = dependencies;
  const TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS =
    dependencies.launchPreflightTimeoutMs ??
    DEFAULT_TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS;
  const finishClaimedTaskFailure = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
    failure?: unknown,
  ): Promise<void> => {
    let cleanupError: unknown = null;
    try {
      await repository.taskDispatch.heartbeat(claim.lease);
      let completed = false;
      try {
        const operation = await repository.tasks.getOperationContext(
          ownerId,
          claim.cycle.chatId,
          { operationId: claim.cycle.operationId },
        );
        completed = Boolean(operation?.relayResult);
        if (operation && !completed) {
          await repository.tasks.failOperation(
            ownerId,
            claim.cycle.chatId,
            claim.cycle.operationId,
          );
        }
      } catch (error) {
        cleanupError = error;
        app.log.error(
          {
            event: "task.operation.failure-persistence-failed",
            subsystem: "task-scheduler",
            operation: "settle-failed-operation",
            status: "failed",
            chatId: claim.cycle.chatId,
            cycleId: claim.cycle.id,
            err: error,
          },
          "Could not persist the failed Task operation",
        );
      }
      await repository.taskDispatch.settle(
        claim.lease,
        completed ? "succeeded" : "failed",
      );
      if (!completed)
        await repository.taskRetries.noteFailure(
          ownerId,
          claim.cycle.chatId,
          `dispatch:${claim.cycle.id}:${claim.lease.fencingToken}`,
          classifyTaskFailure(failure),
        );
      publishChatInvalidation(claim.cycle.chatId, "task", null, {
        experience: "task",
        projectId: claim.projectId,
      });
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) {
        cleanupError ??= error;
      }
    } finally {
      queueTaskScheduleTick();
    }
    if (cleanupError) throw cleanupError;
  };

  const runClaimedTaskOperation = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
    preparedRuntime: ModelRuntime | null,
  ): Promise<void> => {
    await runAsOwner(ownerId, async () => {
      let launchStage: TaskLaunchStage = "resolve-context";
      try {
        const context = await observeTaskLaunchStage(
          app.log,
          claim.cycle,
          launchStage,
          () => repository.getChatExecutionContext(ownerId, claim.cycle.chatId),
          { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
        );
        if (
          !context ||
          context.experience !== "task" ||
          context.projectId !== claim.projectId ||
          context.workerId !== claim.cycle.physicalWorkerId ||
          context.worktreeId !== claim.cycle.worktreeId
        ) {
          throw new Error("The claimed Task placement is no longer available.");
        }
        launchStage = "resolve-runtime";
        const taskModelConfiguration = claim.cycle.modelConfiguration;
        const taskModelId = taskModelConfiguration?.modelId;
        const taskOperationKind = claim.cycle.operationKind;
        if (
          taskOperationKind === "goal-continuation" ||
          !claim.cycle.modelRouteId ||
          !taskModelId
        ) {
          throw new Error("The claimed Task cycle is not executable yet.");
        }
        const runtime = await observeTaskLaunchStage(
          app.log,
          claim.cycle,
          launchStage,
          async () => {
            if (preparedRuntime) return preparedRuntime;
            const configuredRuntimes = await availableModelRuntimes(
              {
                workerId: context.workerId,
                providerAccountId: claim.cycle.providerAccountId,
              },
              taskModelId,
            );
            return (
              configuredRuntimes.find(
                (candidate) =>
                  candidate.routeId === claim.cycle.modelRouteId &&
                  candidate.provider.accountId ===
                    claim.cycle.providerAccountId,
              ) ?? null
            );
          },
          { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
        );
        if (!runtime) {
          throw new Error(
            "The claimed Task model route is no longer available.",
          );
        }

        launchStage = "load-operation";
        const [task, prior] = await observeTaskLaunchStage(
          app.log,
          claim.cycle,
          launchStage,
          () =>
            Promise.all([
              repository.tasks.get(ownerId, context.chatId),
              repository.tasks.getOperationContext(ownerId, context.chatId, {
                operationId: claim.cycle.operationId,
              }),
            ]),
          { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
        );
        if (!task) throw new Error("The claimed Task no longer exists.");

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
              await repository.taskRetries.noteFailure(
                ownerId,
                context.chatId,
                `goal-launch:${claim.cycle.id}:${claim.lease.fencingToken}`,
                classifyTaskFailure(error),
              );
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
          launchStage = "prepare-operation";
          const prepared = taskEncryptedOperationStartSchema.parse(
            await observeTaskLaunchStage(
              app.log,
              claim.cycle,
              launchStage,
              () =>
                bridge.request(
                  context.workerId,
                  {
                    type: "task.operation.prepare",
                    operationId: claim.cycle.operationId,
                    operationKind: taskOperationKind,
                    task,
                  },
                  { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
                ),
              { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
            ),
          );
          launchStage = "persist-operation";
          const started = await observeTaskLaunchStage(
            app.log,
            claim.cycle,
            launchStage,
            () =>
              repository.tasks.beginOperation(
                ownerId,
                context.chatId,
                prepared,
              ),
            { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
          );
          if (!started) throw new Error("The claimed Task no longer exists.");
          request = started.relayRequest;
          startedTask = started.task;
          publishChatInvalidation(context.chatId, "task", null, context);
        }

        launchStage = "begin-turn";
        const userMessage = await withTaskDispatchLeaseRetention({
          heartbeat: (lease) => repository.taskDispatch.heartbeat(lease),
          lease: claim.lease,
          onHeartbeatError: (error) => {
            if (error instanceof TaskDispatchConflictError) return;
            app.log.warn(
              {
                event: "task.dispatch.preflight-heartbeat-failed",
                subsystem: "task-scheduler",
                operation: "launch-preflight",
                status: "degraded",
                chatId: claim.cycle.chatId,
                cycleId: claim.cycle.id,
                serverVersion: cantripVersion.version,
                err: error,
              },
              "Could not retain the Task dispatch lease during launch preflight",
            );
          },
          operation: () =>
            observeTaskLaunchStage(
              app.log,
              claim.cycle,
              launchStage,
              () =>
                beginTurn(
                  context,
                  {
                    text: "Run the encrypted Task operation.",
                    attachmentIds: startedTask.draftAttachmentIds,
                    idempotencyKey: `task-operation:${request.operationId}`,
                    modelId: taskModelId,
                    reasoningEffort: taskModelConfiguration.reasoningEffort,
                    customSubagentModel:
                      taskModelConfiguration.customSubagentModel,
                    subagentModelId: taskModelConfiguration.subagentModelId,
                    subagentReasoningEffort:
                      taskModelConfiguration.subagentReasoningEffort,
                  },
                  {
                    purpose: "Scheduled encrypted Task operation",
                    encryptedTaskMessages: { userMessage: request.userMessage },
                    preflightWorkerCommandTimeoutMs:
                      TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
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
                        const completed =
                          await repository.tasks.completeOperation(
                            ownerId,
                            context.chatId,
                            request.operationId,
                            relayResult,
                            result.turnId ?? null,
                          );
                        if (!completed) {
                          throw new Error(
                            "Encrypted Task operation was not found.",
                          );
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
                          await repository.taskRetries.clearPending(
                            ownerId,
                            context.chatId,
                          );
                          await repository.taskDispatch.settle(
                            claim.lease,
                            "succeeded",
                          );
                          queueTaskScheduleTick();
                        }
                        publishChatInvalidation(
                          context.chatId,
                          "task",
                          null,
                          context,
                        );
                      },
                      async afterCompleted() {
                        if (request.classification.kind !== "finalize") return;
                        await launchClaimedGoal(request.operationId);
                      },
                      async onFailed({ error }) {
                        await finishClaimedTaskFailure(ownerId, claim, error);
                      },
                    },
                  },
                ),
              { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
            ),
        });
        if (!userMessage.executionLaneId) {
          throw new Error("Encrypted Task operation did not acquire a lane.");
        }
        launchStage = "attach-execution";
        await observeTaskLaunchStage(
          app.log,
          claim.cycle,
          launchStage,
          () =>
            repository.tasks.attachOperationExecution(
              ownerId,
              context.chatId,
              request.operationId,
              {
                executionLaneId: userMessage.executionLaneId!,
                userMessageId: userMessage.id,
              },
            ),
          { timeoutMs: TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS },
        );
      } catch (error) {
        if (
          launchStage === "begin-turn" &&
          error instanceof ExecutionLaneBusyError
        ) {
          await repository.taskDispatch.deferForCapacity(claim.lease);
          publishChatInvalidation(claim.cycle.chatId, "task", null, {
            experience: "task",
            projectId: claim.projectId,
          });
          return;
        }
        app.log.warn(
          {
            event: "task.operation.launch-failed",
            subsystem: "task-scheduler",
            operation: "launch-operation",
            status: "failed",
            reasonCode: "preflight-failed",
            stage: launchStage,
            chatId: claim.cycle.chatId,
            cycleId: claim.cycle.id,
            serverVersion: cantripVersion.version,
            err: error,
          },
          "Scheduled Task operation failed to start",
        );
        await finishClaimedTaskFailure(ownerId, claim, error);
      }
    });
  };

  return { finishClaimedTaskFailure, runClaimedTaskOperation };
}
