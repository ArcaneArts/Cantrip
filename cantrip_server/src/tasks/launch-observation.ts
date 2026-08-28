import type { TaskDispatchCycleSummary } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

export type TaskLaunchStage =
  | "attach-execution"
  | "begin-turn"
  | "persist-operation"
  | "prepare-operation"
  | "resolve-context"
  | "resolve-runtime";

export function observeTaskLaunchStage(
  logger: Pick<FastifyInstance["log"], "debug">,
  cycle: Pick<TaskDispatchCycleSummary, "chatId" | "id">,
  stage: TaskLaunchStage,
): void {
  logger.debug(
    {
      event: "task.operation.launch-stage",
      subsystem: "task-scheduler",
      operation: "launch-operation",
      status: "started",
      chatId: cycle.chatId,
      cycleId: cycle.id,
      stage,
    },
    "Scheduled Task launch stage started",
  );
}
