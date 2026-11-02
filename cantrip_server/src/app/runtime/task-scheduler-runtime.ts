// Production Task scheduler; the loop body is shared unchanged with the Rust
// compatibility corpus. Timer startup and global shutdown retain their caller.
import type { FastifyInstance } from "fastify";
import { cantripVersion } from "@cantrip/version";
import { taskDispatchSchedulerPlan } from "../../db/task-dispatch.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";
import type { createTaskAutomaticRetry } from "./task-automatic-retry.js";
import type { createTaskExecutionRecovery } from "./task-execution-recovery.js";
import type { createTaskDispatchEligibilityRuntime } from "./task-dispatch-eligibility-runtime.js";
import type { createTaskClaimedExecutionRuntime } from "./task-claimed-execution-runtime.js";
import type { createTaskResumedExecutionRuntime } from "./task-resumed-execution-runtime.js";
export type TaskSchedulerDependencies = Pick<
  TaskRouteRuntimeDependencies,
  | "repository"
  | "runAsOwner"
  | "publishChatInvalidation"
  | "serverId"
  | "serverInstanceId"
> &
  ReturnType<typeof createTaskDispatchEligibilityRuntime> & {
    automaticRetry: Pick<
      ReturnType<typeof createTaskAutomaticRetry>,
      "tick" | "drain"
    >;
    taskRecovery: Pick<
      ReturnType<typeof createTaskExecutionRecovery>,
      "reconcile"
    >;
    runClaimedTaskOperation: ReturnType<
      typeof createTaskClaimedExecutionRuntime
    >["runClaimedTaskOperation"];
    runResumedTaskDispatch: ReturnType<
      typeof createTaskResumedExecutionRuntime
    >["runResumedTaskDispatch"];
  };
export function createTaskSchedulerRuntime(
  dependencies: TaskSchedulerDependencies,
  app: Pick<FastifyInstance, "log">,
) {
  const {
    repository,
    runAsOwner,
    publishChatInvalidation,
    serverId,
    serverInstanceId,
    automaticRetry,
    taskRecovery,
    prepareTaskDispatchEligibility,
    prepareTaskResumeEligibility,
    runClaimedTaskOperation,
    runResumedTaskDispatch,
  } = dependencies;
  let activeTaskScheduleTick: Promise<void> | null = null;
  const queueTaskScheduleTick = (): void => {
    if (activeTaskScheduleTick) return;
    activeTaskScheduleTick = (async () => {
      await automaticRetry.tick();
      const schedulerOwners =
        await repository.taskDispatch.listSchedulerOwners();
      for (const schedulerOwner of schedulerOwners) {
        const ownerId = schedulerOwner.ownerId;
        const plan = taskDispatchSchedulerPlan(schedulerOwner);
        await runAsOwner(ownerId, async () => {
          if (plan.reconcileStartedLeases)
            await taskRecovery.reconcile(ownerId);
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
            const preparedEligibility =
              await prepareTaskDispatchEligibility(ownerId);
            while (true) {
              const claimed = await repository.taskDispatch.claimNext(
                ownerId,
                `${serverId}:${serverInstanceId}`,
                preparedEligibility.resolve,
              );
              if (!claimed) break;
              app.log.info(
                {
                  event: "task.scheduler.claimed",
                  subsystem: "task-scheduler",
                  operation: "claim-task",
                  status: "completed",
                  chatId: claimed.cycle.chatId,
                  cycleId: claimed.cycle.id,
                  taskWorkerId: claimed.cycle.selectedTaskWorkerId,
                  workerId: claimed.cycle.physicalWorkerId,
                  modelRouteId: claimed.cycle.modelRouteId,
                  providerAccountId: claimed.cycle.providerAccountId,
                  serverVersion: cantripVersion.version,
                  attempt: claimed.cycle.attemptCount,
                },
                "Queued Task claimed for execution",
              );
              void runClaimedTaskOperation(
                ownerId,
                claimed,
                preparedEligibility.runtimeForClaim(claimed),
              ).catch((error) => {
                app.log.error(
                  {
                    event: "task.scheduler.execution-failed",
                    subsystem: "task-scheduler",
                    operation: "launch-task",
                    status: "failed",
                    chatId: claimed.cycle.chatId,
                    cycleId: claimed.cycle.id,
                    serverVersion: cantripVersion.version,
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

  return {
    queueTaskScheduleTick,
    waitForActiveTaskScheduleTick: async () => {
      await activeTaskScheduleTick;
      await automaticRetry.drain();
    },
  };
}
