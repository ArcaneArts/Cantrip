import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "../../db/repository.js";
import type {
  TaskDispatchEligibilityResolver,
  TaskDispatchResumeEligibilityResolver,
} from "../../db/task-dispatch.js";
import { modelConfigurationFailure } from "../../models/subagent-routing.js";
import {
  TaskLaunchStageTimeoutError,
  withTaskLaunchStageTimeout,
} from "../../tasks/launch-observation.js";
import { TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS } from "../shared/constants.js";
import type {
  PreparedTaskDispatchEligibility,
  TaskRouteRuntimeDependencies,
} from "./task-route-types.js";

type Dependencies = Pick<
  TaskRouteRuntimeDependencies,
  | "repository"
  | "bridge"
  | "routePairsForConfiguration"
  | "availableModelRuntimes"
  | "runtimeCanResumeContext"
>;

/** Resolves provider state before owner-serialized dispatch transactions begin. */
export function createTaskDispatchEligibilityRuntime(
  dependencies: Dependencies,
  app: Pick<FastifyInstance, "log">,
  timeoutMs = TASK_LAUNCH_PREFLIGHT_TIMEOUT_MS,
) {
  const {
    repository,
    bridge,
    routePairsForConfiguration,
    availableModelRuntimes,
    runtimeCanResumeContext,
  } = dependencies;
  const prepareTaskDispatchEligibility = async (
    ownerId: string,
  ): Promise<PreparedTaskDispatchEligibility> => {
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
        runtime: ModelRuntime | null;
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
        let runtime: ModelRuntime | null = null;
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
            const pairs = await withTaskLaunchStageTimeout(
              "resolve-runtime",
              timeoutMs,
              () =>
                routePairsForConfiguration(
                  { ...context, providerAccountId: null },
                  taskWorker.modelConfiguration,
                ),
            );
            const selected = pairs[0]?.root.runtime;
            runtime = selected ?? null;
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
            if (error instanceof TaskLaunchStageTimeoutError) {
              app.log.warn(
                {
                  event: "task.scheduler.eligibility-timeout",
                  subsystem: "task-scheduler",
                  operation: "resolve-eligibility",
                  status: "failed",
                  reasonCode: "runtime-resolution-timeout",
                  chatId: cycle.chatId,
                  cycleId: cycle.id,
                  taskWorkerId: taskWorker.id,
                  workerId: context.workerId,
                  durationMs: error.timeoutMs,
                  err: error,
                },
                "Task runtime eligibility resolution timed out",
              );
            }
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
          runtime,
          taskWorkerRevision: taskWorker.rowVersion,
          worktreeId: context.worktreeId,
        });
      }
    }
    const preparedFor = (cycleId: string, taskWorkerId: string) =>
      resolutions.get(`${cycleId}:${taskWorkerId}`);
    return {
      resolve: async (input) => {
        const prepared = preparedFor(input.cycle.id, input.taskWorker.id);
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
      },
      runtimeForClaim: (claim) => {
        const taskWorkerId = claim.cycle.selectedTaskWorkerId;
        if (!taskWorkerId) return null;
        const prepared = preparedFor(claim.cycle.id, taskWorkerId);
        const runtime = prepared?.runtime ?? null;
        return runtime &&
          runtime.routeId === claim.cycle.modelRouteId &&
          runtime.provider.accountId === claim.cycle.providerAccountId
          ? runtime
          : null;
      },
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
        const runtimes = await withTaskLaunchStageTimeout(
          "resolve-runtime",
          timeoutMs,
          () =>
            availableModelRuntimes(
              {
                workerId: cycle.physicalWorkerId!,
                providerAccountId: cycle.providerAccountId,
              },
              cycle.modelConfiguration!.modelId!,
            ),
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
      } catch (error) {
        if (error instanceof TaskLaunchStageTimeoutError) {
          app.log.warn(
            {
              event: "task.scheduler.resume-eligibility-timeout",
              subsystem: "task-scheduler",
              operation: "resolve-resume-eligibility",
              status: "failed",
              reasonCode: "runtime-resolution-timeout",
              chatId: cycle.chatId,
              cycleId: cycle.id,
              workerId: cycle.physicalWorkerId,
              durationMs: error.timeoutMs,
              err: error,
            },
            "Paused Task runtime eligibility resolution timed out",
          );
        }
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

  return { prepareTaskDispatchEligibility, prepareTaskResumeEligibility };
}
