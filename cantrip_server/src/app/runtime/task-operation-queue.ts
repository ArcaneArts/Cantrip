import type {
  TaskOpaqueSummary,
  TaskOperationStart,
} from "@cantrip/protocol/tasks";
import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

export function createTaskOperationQueue({
  repository,
  applicationOwnerId,
  publishChatInvalidation,
  queueTaskScheduleTick,
  nameTask,
}: Pick<
  TaskRouteRuntimeDependencies,
  "repository" | "applicationOwnerId" | "publishChatInvalidation"
> & {
  queueTaskScheduleTick(): void;
  nameTask(task: TaskOpaqueSummary): void;
}) {
  return async (
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
    const task = await repository.tasks.get(ownerId, chatId);
    if (
      task &&
      (operationKind === "direct" || operationKind === "initial-plan")
    )
      nameTask(task);
    queueTaskScheduleTick();
    return task;
  };
}
