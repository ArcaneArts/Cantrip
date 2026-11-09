import type { WorkerCommand } from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ModelRuntime,
} from "../../db/repository.js";
import { prepareManagedTurnConfiguration } from "../../terminals/managed-session.js";

/** Task Goal activation needs the same full configuration as a normal turn,
 * but must not create a console thread before the worker installs its gate. */
export async function prepareTaskGoalConfiguration(
  context: ChatExecutionContext,
  runtime: ModelRuntime,
  dependencies: Parameters<typeof prepareManagedTurnConfiguration>[2],
) {
  if (context.experience !== "task" || context.contextKind !== "project")
    throw new Error("Task Goals require their project execution context.");
  const { configuration } = await prepareManagedTurnConfiguration(
    context,
    runtime,
    dependencies,
  );
  const taskRuntime: NonNullable<
    Extract<WorkerCommand, { type: "chat.goal.create" }>["taskRuntime"]
  > = {
    projectId: context.projectId,
    worktreeId: context.worktreeId,
    rootKind: context.rootKind,
    computerUseEnabled: context.computerUseEnabled ?? false,
  };
  return {
    ...configuration,
    taskRuntime,
    ...(context.osExecution ? { osExecution: context.osExecution } : {}),
  };
}
