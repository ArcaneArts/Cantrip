import type { TaskMessageOpaqueContent } from "@cantrip/protocol";
import {
  CodexTurnFailureError,
  type CodexAppServer,
  type TaskGoalPublisher,
} from "./codex/app-server.js";
import { createTaskSuspensionCapture } from "./codex/managed-native-suspension.js";
import type { NativeSuspensionStore } from "./native-suspension-store.js";
import type { GoalOutcomeScope } from "./task-goal-outcome-delivery.js";
import {
  encryptTaskTurnResult,
  type EncryptedTaskEventSealer,
} from "./task-operation.js";
import type { WorkerConnection } from "./transport.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export function createTaskGoalPublisher(input: {
  runtime: CodexAppServer;
  store: NativeSuspensionStore;
  connection: WorkerConnection;
  encryption: WorkerEncryptionService;
  scope: GoalOutcomeScope;
  chatId: string;
  projectId: string;
  prompt: TaskMessageOpaqueContent;
  eventSealer: EncryptedTaskEventSealer;
  settleEvents: () => Promise<void>;
  reusePublishedResponse?: boolean;
}): TaskGoalPublisher {
  const assertParent = (
    source: Parameters<TaskGoalPublisher["capture"]>[0],
  ) => {
    if (
      source.parent.chatId !== input.chatId ||
      source.parent.clientMessageId !== input.prompt.id
    )
      throw new Error(
        "The autonomous Goal publisher belongs to another canonical input.",
      );
  };
  return {
    capture(source, active) {
      assertParent(source);
      return createTaskSuspensionCapture(input.runtime, input.store, {
        kind: "goal-cycle",
        receipt: source.parent,
        goalCycle: source,
        projectId: input.projectId,
        prompt: input.prompt,
        publication: source.publication,
        events: async () => {
          await input.settleEvents();
          return input.eventSealer.snapshot();
        },
      })(active);
    },
    async complete(source, result) {
      assertParent(source);
      await input.settleEvents();
      const outcome =
        result instanceof CodexTurnFailureError
          ? {
              ok: false as const,
              error:
                result.terminalStatus === "interrupted"
                  ? "The autonomous Task Goal turn was interrupted."
                  : "The autonomous Task Goal turn failed.",
            }
          : {
              ok: true as const,
              result: await encryptTaskTurnResult({
                eventSealer: input.eventSealer,
                reusePublishedResponse: input.reusePublishedResponse,
                getComponentKey: () =>
                  input.encryption.componentKey("task-content"),
                idempotencyKey: source.publication.idempotencyKey,
                messageId: source.publication.id,
                ownerId: input.scope.ownerId,
                result,
                mode: "goal",
              }),
            };
      await input.connection.deliverGoalCycleOutcome(
        {
          type: "chat.turn.outcome",
          chatId: source.parent.chatId,
          clientMessageId: source.parent.clientMessageId,
          executionLaneId: source.parent.executionLaneId,
          contextKind: "project",
          scratchRootId: null,
          worktreeId: source.parent.worktreeId,
          outcome,
        },
        source,
        input.scope,
      );
    },
  };
}
