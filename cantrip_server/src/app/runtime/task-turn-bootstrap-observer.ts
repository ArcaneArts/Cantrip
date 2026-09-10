import { cantripVersion } from "@cantrip/version";
import { withTaskLaunchStageTimeout } from "../../tasks/launch-observation.js";
import type {
  ChatTurnOptions,
  ChatTurnRuntimeDependencies,
} from "./chat-turn-types.js";
import type { ChatExecutionContext } from "../../db/repository.js";

export type TaskTurnBootstrapStage =
  | "acquire-execution-lane"
  | "append-task-message"
  | "attribute-task-message"
  | "load-message-headers"
  | "load-worker-attribution"
  | "mark-dispatch-running"
  | "notify-code-agent-started"
  | "persist-chat-runtime"
  | "persist-turn-mode"
  | "prepare-code-editors"
  | "resolve-attachments"
  | "resolve-effective-policies"
  | "resolve-mcp-servers"
  | "resolve-model"
  | "resolve-model-routes";

/** Scheduled-turn stage logging and timeout semantics, shared with admission. */
export function createTaskTurnBootstrapObserver(
  app: ChatTurnRuntimeDependencies["app"],
  context: ChatExecutionContext,
  options: ChatTurnOptions,
) {
  return async <T>(
    stage: TaskTurnBootstrapStage,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const lease = options.taskDispatchLease;
    if (!lease) return operation();
    const startedAt = Date.now();
    app.log.info(
      {
        event: "task.turn-bootstrap-stage",
        subsystem: "task-scheduler",
        operation: "bootstrap-turn",
        status: "started",
        chatId: context.chatId,
        cycleId: lease.cycleId,
        operationId: lease.operationId,
        serverVersion: cantripVersion.version,
        stage,
      },
      "Scheduled Task turn bootstrap stage started",
    );
    try {
      const result =
        options.preflightWorkerCommandTimeoutMs === undefined ||
        options.preflightWorkerCommandTimeoutMs === null
          ? await operation()
          : await withTaskLaunchStageTimeout(
              "begin-turn",
              options.preflightWorkerCommandTimeoutMs,
              operation,
            );
      app.log.info(
        {
          event: "task.turn-bootstrap-stage",
          subsystem: "task-scheduler",
          operation: "bootstrap-turn",
          status: "completed",
          chatId: context.chatId,
          cycleId: lease.cycleId,
          operationId: lease.operationId,
          serverVersion: cantripVersion.version,
          stage,
          durationMs: Date.now() - startedAt,
        },
        "Scheduled Task turn bootstrap stage completed",
      );
      return result;
    } catch (error) {
      app.log.warn(
        {
          event: "task.turn-bootstrap-stage",
          subsystem: "task-scheduler",
          operation: "bootstrap-turn",
          status: "failed",
          chatId: context.chatId,
          cycleId: lease.cycleId,
          operationId: lease.operationId,
          serverVersion: cantripVersion.version,
          stage,
          durationMs: Date.now() - startedAt,
          err: error,
        },
        "Scheduled Task turn bootstrap stage failed",
      );
      throw error;
    }
  };
}
export type TaskTurnBootstrapObserver = ReturnType<
  typeof createTaskTurnBootstrapObserver
>;
