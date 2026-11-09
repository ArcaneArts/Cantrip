// Production paused Task dispatch, shared with the Rust compatibility corpus.
import type { ChatExecutionContext } from "../../db/repository.js";
import {
  TaskDispatchConflictError,
  type ClaimedTaskDispatch,
} from "../../db/task-dispatch.js";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";
import type { createChatAutomationPauseRuntime } from "./chat-automation-pause-runtime.js";
import type { createTaskClaimedExecutionRuntime } from "./task-claimed-execution-runtime.js";
export type TaskResumedExecutionDependencies = Pick<
  TaskRouteRuntimeDependencies,
  | "repository"
  | "bridge"
  | "retainTaskGoalLease"
  | "resumeChatAutomation"
  | "runAsOwner"
  | "publishChatInvalidation"
> & {
  setChatAutomationPause: ReturnType<typeof createChatAutomationPauseRuntime>;
  runClaimedTaskOperation: ReturnType<
    typeof createTaskClaimedExecutionRuntime
  >["runClaimedTaskOperation"];
};
export function createTaskResumedExecutionRuntime(
  dependencies: TaskResumedExecutionDependencies,
) {
  const {
    repository,
    bridge,
    retainTaskGoalLease,
    resumeChatAutomation,
    runAsOwner,
    publishChatInvalidation,
    setChatAutomationPause,
    runClaimedTaskOperation,
  } = dependencies;
  const runResumedTaskDispatch = async (
    ownerId: string,
    claim: ClaimedTaskDispatch,
  ): Promise<void> => {
    await runAsOwner(ownerId, async () => {
      let context: ChatExecutionContext | null = null;
      try {
        context = await repository.getChatExecutionContext(
          ownerId,
          claim.cycle.chatId,
        );
        if (
          !context ||
          context.experience !== "task" ||
          context.projectId !== claim.projectId ||
          context.workerId !== claim.cycle.physicalWorkerId ||
          context.worktreeId !== claim.cycle.worktreeId
        ) {
          throw new Error("The paused Task placement is no longer available.");
        }
        const resumed = await setChatAutomationPause(
          ownerId,
          context.chatId,
          false,
          {
            resumeAutomation: false,
          },
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
            (task?.state === "implementing" || task?.state === "paused")
          ) {
            await retainTaskGoalLease(claim.lease);
            await resumeChatAutomation(context.chatId);
          } else {
            await runClaimedTaskOperation(ownerId, claim, null);
          }
        }
        if (claim.cycle.operationKind === "finalize") {
          await retainTaskGoalLease(claim.lease);
        }
        publishChatInvalidation(context.chatId, "task", null, context);
      } catch (error) {
        if (context && bridge.isConnected(context.workerId)) {
          await setChatAutomationPause(ownerId, context.chatId, true).catch(
            () => undefined,
          );
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

  return { runResumedTaskDispatch };
}
