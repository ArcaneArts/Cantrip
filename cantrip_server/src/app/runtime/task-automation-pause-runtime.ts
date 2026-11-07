import { isDeepStrictEqual } from "node:util";
import {
  taskPauseRuntimeStateSchema,
  chatNativeSuspension,
  type NativeSuspensionRecord,
  type ChatPauseRuntimeState,
  type TaskPauseIntent,
} from "@cantrip/protocol";
import { settleTaskGoalHandoffForControl } from "../../terminals/task-goal-handoff-control.js";
import type { ChatAutomationPauseRouteDependencies } from "./chat-automation-pause-runtime.js";
import { ChatAutomationPauseError } from "./chat-automation-pause-error.js";
import { errorMessage } from "../../http/request-helpers.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";

type Dependencies = Pick<
  ChatAutomationPauseRouteDependencies,
  | "repository"
  | "bridge"
  | "publishChatSummary"
  | "resumeChatAutomation"
  | "resumeTaskSuspension"
>;

/** Persist intent once. Every reply observes current canonical intent rather
 * than allowing an older HTTP/native acknowledgement to write it again. */
export async function setTaskAutomationPause(
  ownerId: string,
  chatId: string,
  paused: boolean,
  resumeAutomation: boolean,
  dependencies: Dependencies,
): Promise<ChatPauseRuntimeState> {
  const { repository, bridge, publishChatSummary } = dependencies;
  const original = await repository.taskAutomationPause.request(
    ownerId,
    chatId,
    paused,
  );
  if (!original)
    throw new ChatAutomationPauseError(404, "Task source not found.");
  const publish = (intent: TaskPauseIntent) =>
    publishChatSummary(chatId, intent.scope.projectId);
  const send = (intent: TaskPauseIntent, waitForBoundary = true) =>
    bridge.request(
      intent.scope.workerId,
      {
        type: "chat.pause.set",
        chatId,
        paused: intent.paused,
        task: intent.scope,
        waitForBoundary,
      },
      { ownerId, timeoutMs: null },
    );
  const rollbackResume = async (intent: TaskPauseIntent) => {
    if (intent.paused || intent.scope.revision !== original.scope.revision)
      return;
    // Only the still-current failed Resume may request a compensating Pause.
    const restored = await repository.taskAutomationPause.request(
      ownerId,
      chatId,
      true,
      intent.scope.revision,
    );
    if (restored) {
      publish(restored);
      await send(restored, false).catch(() => undefined);
    }
  };
  let intent = original;
  let active: ChatPauseRuntimeState["active"] = null;
  let suspension: NativeSuspensionRecord | null = null;
  for (;;) {
    try {
      // The durable pause closes new handoff admission before this second read.
      // A transfer which raced the first control read must settle on its actual
      // source/destination before selecting the worker's current root.
      await settleTaskGoalHandoffForControl(ownerId, chatId, dependencies);
      const current = await repository.taskAutomationPause.read(
        ownerId,
        chatId,
      );
      if (!current)
        throw new ChatAutomationPauseError(404, "Task source not found.");
      intent = current;
      suspension = null;
      const previous =
        intent.scope.taskRound || intent.scope.taskGoalCycle
          ? await repository.nativeSuspensions.read(ownerId, chatId)
          : null;
      if (!intent.paused && previous?.phase === "running") {
        suspension = previous;
      } else if (
        (intent.scope.taskRound || intent.scope.taskGoalCycle) &&
        (intent.paused || previous?.checkpoint)
      ) {
        suspension = (
          await repository.nativeSuspensions.request(
            ownerId,
            chatId,
            intent.paused ? "pause" : "resume",
            undefined,
            intent.scope.revision,
          )
        ).state;
        publish(intent);
      }
      if (
        !intent.paused &&
        suspension?.checkpoint &&
        dependencies.resumeTaskSuspension
      )
        return await dependencies.resumeTaskSuspension(
          ownerId,
          chatId,
          suspension,
          intent,
        );
      const receipt = taskPauseRuntimeStateSchema.parse(await send(intent));
      const latest = await repository.taskAutomationPause.read(ownerId, chatId);
      if (!latest)
        throw new ChatAutomationPauseError(404, "Task source not found.");
      if (!isDeepStrictEqual(intent, latest)) {
        intent = latest;
        continue;
      }
      if (receipt.paused !== intent.paused)
        throw new Error(
          "The current native Task pause intent was not acknowledged.",
        );
      active = receipt.active;
      if (suspension) {
        if (!active || !receipt.execution)
          throw new Error(
            "The saved Task continuation has no live native owner. It remains paused for recovery.",
          );
        const actor = receipt.execution.actor;
        if (suspension.phase === "running" && !intent.paused) {
          if (
            !isDeepStrictEqual(suspension.actor, receipt.execution.actor) ||
            !isDeepStrictEqual(suspension.active, active)
          )
            throw new Error(
              "The running Task changed its native execution owner.",
            );
        } else if (suspension.phase === "paused" && intent.paused) {
          if (
            !isDeepStrictEqual(
              suspension.checkpoint,
              receipt.execution.checkpoint,
            )
          )
            throw new Error(
              "The Task pause checkpoint changed after acknowledgement.",
            );
        } else {
          suspension = (
            await repository.nativeSuspensions.claim(
              ownerId,
              chatId,
              suspension.controlId,
              suspension.actor,
              actor,
              active,
            )
          ).state;
          if (intent.paused) {
            if (!receipt.execution.checkpoint)
              throw new Error("The Task durable checkpoint is missing.");
            suspension = (
              await repository.nativeSuspensions.paused(
                ownerId,
                chatId,
                suspension.controlId,
                actor,
                receipt.execution.checkpoint,
              )
            ).state;
          } else {
            suspension = (
              await repository.nativeSuspensions.running(
                ownerId,
                chatId,
                suspension.controlId,
                actor,
              )
            ).state;
          }
        }
      }
      break;
    } catch (error) {
      if (
        error instanceof NativeCommandError &&
        error.code === "suspension-control-stale"
      ) {
        const latest = await repository.taskAutomationPause.read(
          ownerId,
          chatId,
        );
        if (latest && !isDeepStrictEqual(latest, intent)) {
          intent = latest;
          continue;
        }
      }
      if (suspension && ["pausing", "resuming"].includes(suspension.phase)) {
        await repository.nativeSuspensions
          .failedControl(
            ownerId,
            chatId,
            suspension.controlId,
            suspension.actor,
            {
              code: intent.paused ? "pause-failed" : "restore-failed",
              protectedDetails: null,
            },
          )
          .catch(() => undefined);
      }
      await rollbackResume(intent);
      publish(intent);
      if (error instanceof ChatAutomationPauseError) throw error;
      throw new ChatAutomationPauseError(
        502,
        `The worker could not confirm this Task control: ${errorMessage(error)}`,
      );
    }
  }
  publish(intent);
  if (
    resumeAutomation &&
    !intent.paused &&
    !active &&
    intent.scope.revision === original.scope.revision
  ) {
    try {
      await dependencies.resumeChatAutomation(chatId);
    } catch (error) {
      await rollbackResume(intent);
      throw new ChatAutomationPauseError(
        409,
        `The Task could not continue: ${errorMessage(error)}`,
      );
    }
  }
  // A later device may have changed intent while the continuation was checked.
  const latest = await repository.taskAutomationPause.read(ownerId, chatId);
  return {
    paused: latest?.paused ?? intent.paused,
    active,
    ...(suspension
      ? { nativeSuspension: chatNativeSuspension(suspension) }
      : {}),
  };
}
