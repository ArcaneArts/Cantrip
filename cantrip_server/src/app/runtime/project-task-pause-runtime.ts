import { chatIsExecuting } from "../../chats/execution-helpers.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import { errorMessage } from "../../http/request-helpers.js";
import type { createChatAutomationPauseRuntime } from "./chat-automation-pause-runtime.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

type Dependencies = Pick<
  TaskRouteRuntimeDependencies,
  | "repository"
  | "releaseTaskGoalLease"
  | "taskDispatchCycleLease"
  | "publishChatInvalidation"
  | "publishChatSummary"
> & {
  setChatAutomationPause: ReturnType<typeof createChatAutomationPauseRuntime>;
};

/** Applies list controls to the same durable automation state used by Chat. */
export function createProjectTaskPauseRuntime({
  repository,
  releaseTaskGoalLease,
  taskDispatchCycleLease,
  publishChatInvalidation,
  publishChatSummary,
  setChatAutomationPause,
}: Dependencies) {
  return async (
    ownerId: string,
    projectId: string,
    paused: boolean,
  ): Promise<void> => {
    const tasks = await repository.tasks.list(ownerId, projectId);
    const results = await Promise.allSettled(
      tasks.map(async (task) => {
        if (task.state === "complete" || task.state === "failed") return;
        const context = await repository.getChatExecutionContext(
          ownerId,
          task.chatId,
        );
        if (
          !context ||
          context.projectId !== projectId ||
          context.experience !== "task"
        )
          return;
        const cycle = task.dispatch;
        if (!paused) {
          // The scheduler reacquires capacity and the dispatch lease before resuming
          // resident turns. It calls the same Chat control once that lease is held.
          if (cycle?.state === "paused" || !context.automationPaused) return;
          await setChatAutomationPause(ownerId, context.chatId, false);
          publishChatInvalidation(context.chatId, "task", null, context);
          return;
        }
        const lease =
          cycle && (cycle.state === "claimed" || cycle.state === "running")
            ? taskDispatchCycleLease(cycle)
            : null;
        if (
          cycle?.state === "claimed" &&
          lease &&
          !chatIsExecuting(context.status)
        ) {
          await repository.setChatAutomationPaused(
            ownerId,
            context.chatId,
            true,
          );
          publishChatSummary(context.chatId, projectId);
          releaseTaskGoalLease(cycle.id);
          try {
            await repository.taskDispatch.pauseUnstarted(lease, {
              threadId: cycle.codexThreadId ?? context.threadId,
              turnId: cycle.turnId,
            });
          } catch (error) {
            if (!(error instanceof TaskDispatchConflictError)) throw error;
          }
          publishChatInvalidation(context.chatId, "task", null, context);
          return;
        }
        if (
          !lease &&
          !chatIsExecuting(context.status) &&
          task.state !== "implementing" &&
          task.state !== "paused"
        )
          return;
        const receipt = await setChatAutomationPause(
          ownerId,
          context.chatId,
          true,
        );
        if (!receipt.paused)
          throw new Error("The worker did not acknowledge the Task pause.");
        if (lease && cycle) {
          releaseTaskGoalLease(cycle.id);
          try {
            await repository.taskDispatch.pause(lease, {
              threadId:
                receipt.active?.threadId ??
                cycle.codexThreadId ??
                context.threadId,
              turnId: receipt.active?.turnId ?? cycle.turnId,
            });
          } catch (error) {
            if (!(error instanceof TaskDispatchConflictError)) throw error;
          }
        }
        publishChatInvalidation(context.chatId, "task", null, context);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : [],
    );
    if (failures.length)
      throw new Error(
        `${failures.length} Task${failures.length === 1 ? "" : "s"} could not ${paused ? "pause" : "resume"}: ${failures.join("; ")}`,
      );
  };
}
