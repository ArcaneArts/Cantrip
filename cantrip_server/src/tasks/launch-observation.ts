import type { TaskDispatchCycleSummary } from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";
import type { FastifyInstance } from "fastify";

export type TaskLaunchStage =
  | "attach-execution"
  | "begin-turn"
  | "load-operation"
  | "persist-operation"
  | "prepare-operation"
  | "resolve-context"
  | "resolve-runtime";

type TaskLaunchLogger = Pick<FastifyInstance["log"], "info" | "warn">;

export const DEFAULT_TASK_LAUNCH_STAGE_TIMEOUT_MS = 30_000;

interface ObserveTaskLaunchStageOptions {
  slowWarningMs?: number | null;
  timeoutMs?: number | null;
}

export class TaskLaunchStageTimeoutError extends Error {
  constructor(
    readonly stage: TaskLaunchStage,
    readonly timeoutMs: number,
  ) {
    super(
      `Scheduled Task launch timed out during ${stage} after ${timeoutMs}ms.`,
    );
    this.name = "TaskLaunchStageTimeoutError";
  }
}

export async function withTaskLaunchStageTimeout<T>(
  stage: TaskLaunchStage,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new TaskLaunchStageTimeoutError(stage, timeoutMs)),
          timeoutMs,
        );
        timeoutTimer.unref();
      }),
    ]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

/**
 * Emits a complete launch-stage lifecycle and prevents remote/read-only
 * preflight work from retaining Task Worker capacity forever.
 */
export async function observeTaskLaunchStage<T>(
  logger: TaskLaunchLogger,
  cycle: Pick<TaskDispatchCycleSummary, "chatId" | "id">,
  stage: TaskLaunchStage,
  operation: () => Promise<T>,
  {
    slowWarningMs = 5_000,
    timeoutMs = DEFAULT_TASK_LAUNCH_STAGE_TIMEOUT_MS,
  }: ObserveTaskLaunchStageOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  logger.info(
    {
      event: "task.operation.launch-stage",
      subsystem: "task-scheduler",
      operation: "launch-operation",
      status: "started",
      chatId: cycle.chatId,
      cycleId: cycle.id,
      serverVersion: cantripVersion.version,
      stage,
    },
    "Scheduled Task launch stage started",
  );

  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  if (slowWarningMs !== null) {
    slowTimer = setTimeout(() => {
      logger.warn(
        {
          event: "task.operation.launch-stage",
          subsystem: "task-scheduler",
          operation: "launch-operation",
          status: "waiting",
          reasonCode: "slow-stage",
          chatId: cycle.chatId,
          cycleId: cycle.id,
          durationMs: Date.now() - startedAt,
          serverVersion: cantripVersion.version,
          stage,
        },
        "Scheduled Task launch stage is still waiting",
      );
    }, slowWarningMs);
    slowTimer.unref();
  }

  try {
    const result =
      timeoutMs === null
        ? await operation()
        : await withTaskLaunchStageTimeout(stage, timeoutMs, operation);
    logger.info(
      {
        event: "task.operation.launch-stage",
        subsystem: "task-scheduler",
        operation: "launch-operation",
        status: "completed",
        chatId: cycle.chatId,
        cycleId: cycle.id,
        durationMs: Date.now() - startedAt,
        serverVersion: cantripVersion.version,
        stage,
      },
      "Scheduled Task launch stage completed",
    );
    return result;
  } catch (error) {
    logger.warn(
      {
        event: "task.operation.launch-stage",
        subsystem: "task-scheduler",
        operation: "launch-operation",
        status: "failed",
        reasonCode:
          error instanceof TaskLaunchStageTimeoutError
            ? "stage-timeout"
            : "stage-failed",
        chatId: cycle.chatId,
        cycleId: cycle.id,
        durationMs: Date.now() - startedAt,
        serverVersion: cantripVersion.version,
        stage,
        err: error,
      },
      "Scheduled Task launch stage failed",
    );
    throw error;
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
  }
}
