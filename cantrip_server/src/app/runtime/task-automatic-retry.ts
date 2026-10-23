import { randomUUID } from "node:crypto";
import type {
  TaskOpaqueSummary,
  TaskOperationKind,
  TaskOperationStart,
} from "@cantrip/protocol/tasks";
import type {
  ServerRepository,
  ChatExecutionContext,
} from "../../db/repository.js";
import { TaskDispatchConflictError } from "../../db/task-dispatch.js";
import { classifyTaskFailure } from "../../tasks/automatic-retry.js";

/** Preserve saved finalization/Goal receipts; ordinary failed operations get a fresh attempt. */
export async function retryTaskOperation(
  repository: ServerRepository,
  ownerId: string,
  task: TaskOpaqueSummary,
  queue: (
    chatId: string,
    input: TaskOperationStart,
    kind: TaskOperationKind,
  ) => Promise<TaskOpaqueSummary | null>,
  operationId: string = randomUUID(),
) {
  const kind = task.lastError?.operationKind ?? task.dispatch?.operationKind;
  if (!kind || kind === "implementation" || kind === "goal-continuation")
    throw new Error(
      "Use the implementation Goal controls to recover this Task.",
    );
  if (kind === "finalize") {
    const rounds = await repository.tasks.listRounds(ownerId, task.chatId);
    const latest = rounds.find((round) => round.ordinal === task.planningRound);
    const saved = latest
      ? await repository.tasks.getOperationContext(ownerId, task.chatId, {
          operationId: latest.id,
        })
      : null;
    if (saved?.relayResult?.goal) operationId = latest!.id;
  }
  return queue(task.chatId, { operationId, rowVersion: task.rowVersion }, kind);
}

export function createTaskAutomaticRetry({
  repository,
  recover,
  observe,
  queue,
  runAsOwner,
  publish,
  report,
}: {
  repository: ServerRepository;
  recover(
    chatId: string,
    resume: boolean,
    automatic: boolean,
  ): Promise<boolean>;
  observe(
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
  ): Promise<{ execution?: { threadId: string; status: string } }>;
  queue(
    chatId: string,
    input: TaskOperationStart,
    kind: TaskOperationKind,
  ): Promise<TaskOpaqueSummary | null>;
  runAsOwner<T>(ownerId: string, operation: () => T): T;
  publish(chatId: string, projectId: string | null): void;
  report(chatId: string, error: unknown): void;
}) {
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  async function tick() {
    if (stopped) return;
    const candidates = await repository.taskRetries.listCandidates();
    // A slow/offline worker must not stall every other Task's recovery timer.
    for (const candidate of candidates) {
      if (stopped || active.size >= 4) break;
      if (active.has(candidate.chatId)) continue;
      const operation = Promise.resolve()
        .then(() =>
          runAsOwner(candidate.ownerId, async () => {
            const { ownerId, chatId, projectId } = candidate;
            try {
              let task = await repository.tasks.get(ownerId, chatId);
              if (!task) return;
              // Adopt pre-upgrade failures once. Human blockers never enter this path.
              if (
                !task.automaticRetry &&
                task.state === "failed" &&
                task.lastError
              ) {
                const changed = await repository.taskRetries.noteFailure(
                  ownerId,
                  chatId,
                  `observed:${task.lastError.code}:${task.lastError.occurredAt}`,
                  classifyTaskFailure(task.lastError.code),
                );
                if (changed) publish(chatId, projectId);
              }
              const claim = await repository.taskRetries.claimDue(
                ownerId,
                chatId,
              );
              if (!claim) return;
              publish(chatId, projectId);
              try {
                task = await repository.tasks.get(ownerId, chatId);
                if (!task || task.rowVersion !== claim.rowVersion) {
                  await repository.taskRetries.finish(
                    ownerId,
                    chatId,
                    claim.id,
                  );
                  return;
                }
                if (
                  task.planGoalEnabled &&
                  task.implementationStartedAt &&
                  task.dispatch?.codexThreadId
                ) {
                  if (!(await recover(chatId, true, true)))
                    throw new Error(
                      "Task implementation recovery is unavailable.",
                    );
                } else {
                  const context = await repository.getChatExecutionContext(
                    ownerId,
                    chatId,
                  );
                  if (!context)
                    throw new Error("The Task placement is unavailable.");
                  if (context.threadId) {
                    const observed = await observe(context, task);
                    if (observed.execution?.threadId !== context.threadId)
                      throw new Error(
                        "The previous native Task execution could not be observed. No new turn was started.",
                      );
                    if (!["idle", "failed"].includes(observed.execution.status))
                      throw new TaskDispatchConflictError(
                        "Waiting for the previous native Task turn to stop before retrying.",
                        "active-operation",
                      );
                  }
                  await retryTaskOperation(
                    repository,
                    ownerId,
                    task,
                    queue,
                    claim.id,
                  );
                }
                await repository.taskRetries.finish(ownerId, chatId, claim.id);
              } catch (error) {
                await repository.taskRetries.finish(ownerId, chatId, claim.id, {
                  kind: classifyTaskFailure(error),
                  defer:
                    error instanceof TaskDispatchConflictError &&
                    error.code === "active-operation",
                });
                report(chatId, error);
              }
              publish(chatId, projectId);
            } catch (error) {
              report(chatId, error);
            }
          }),
        )
        .catch((error) => report(candidate.chatId, error))
        .finally(() => active.delete(candidate.chatId));
      active.set(candidate.chatId, operation);
    }
  }
  return {
    tick,
    stop: () => {
      stopped = true;
    },
    drain: () => Promise.all(active.values()),
  };
}
