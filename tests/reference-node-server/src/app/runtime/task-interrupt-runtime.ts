import { chatInterruptAcceptedSchema } from "@cantrip/protocol";
import type {
  ServerRepository,
  ChatExecutionContext,
  ModelRuntime,
} from "../../db/repository.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { settleTaskGoalHandoffForControl } from "../../terminals/task-goal-handoff-control.js";
import { ChatAutomationPauseError } from "./chat-automation-pause-error.js";
import { errorMessage } from "../../http/request-helpers.js";

/** Stop closes future Task admission before selecting the actual current root.
 * Native execution, not cached chat status or a model lookup, decides what ends. */
async function interruptTaskOnce(
  ownerId: string,
  chatId: string,
  dependencies: {
    repository: Pick<
      ServerRepository,
      | "taskAutomationPause"
      | "nativeRuntimeHandoffs"
      | "nativeSuspensions"
      | "chatExecutionLanes"
    >;
    bridge: Pick<WorkerCommandBus, "request">;
    publishChatSummary(chatId: string, projectId: string | null): void;
    runtimeForContext(
      context: ChatExecutionContext,
    ): Promise<ModelRuntime | null>;
  },
) {
  const { repository, bridge, publishChatSummary } = dependencies;
  const previous = await repository.nativeSuspensions.prepareTaskStop(
    ownerId,
    chatId,
  );
  if (previous?.stop === null) return { interrupted: true };
  const original = await repository.taskAutomationPause.request(
    ownerId,
    chatId,
    true,
  );
  if (!original)
    throw new ChatAutomationPauseError(404, "Task source not found.");
  try {
    await settleTaskGoalHandoffForControl(ownerId, chatId, dependencies);
    const current = await repository.taskAutomationPause.fenceInterrupt(
      ownerId,
      chatId,
      original.scope.revision,
    );
    if (
      !current ||
      !current.paused ||
      current.scope.revision !== original.scope.revision
    )
      return { interrupted: false };
    const stopped = await repository.nativeSuspensions.prepareTaskStop(
      ownerId,
      chatId,
    );
    if (stopped?.stop && stopped.context) {
      // A surviving native owner can Stop using its retained configuration even
      // after the provider route disappeared. Cold attachment tries fresh routing.
      const runtime = await dependencies
        .runtimeForContext(stopped.context)
        .catch(() => null);
      try {
        const proof = await bridge.request(
          current.scope.workerId,
          {
            type: "chat.interrupt",
            executionProfile: "ide",
            chatId,
            threadId: stopped.stop.active.threadId,
            taskStop: {
              ...stopped.stop,
              scope: current.scope,
              cwd: stopped.context.cwd,
              ...(runtime
                ? { model: runtime.model, provider: runtime.provider }
                : {}),
              permissionProfileId: effectivePermissionProfile(stopped.context)
                .effectiveId,
            },
          },
          { ownerId, timeoutMs: null },
        );
        await repository.nativeSuspensions.acknowledgeTaskStop(
          ownerId,
          chatId,
          stopped.stop,
          current.scope,
          proof,
          repository.chatExecutionLanes,
        );
        return { interrupted: true };
      } catch (error) {
        await repository.nativeSuspensions
          .failedControl(
            ownerId,
            chatId,
            stopped.state.controlId,
            stopped.state.actor,
            { code: "stop-failed", protectedDetails: null },
          )
          .catch(() => {});
        throw error;
      }
    }
    return chatInterruptAcceptedSchema.parse(
      await bridge.request(
        current.scope.workerId,
        {
          type: "chat.interrupt",
          executionProfile: "ide",
          chatId,
          threadId: current.scope.threadId,
          task: current.scope,
        },
        { ownerId, timeoutMs: null },
      ),
    );
  } catch (error) {
    throw new ChatAutomationPauseError(
      502,
      `The worker could not confirm this Task interruption: ${errorMessage(error)}`,
    );
  } finally {
    publishChatSummary(chatId, original.scope.projectId);
  }
}

const pending = new WeakMap<
  object,
  Map<string, Promise<{ interrupted: boolean }>>
>();
export function interruptTask(...args: Parameters<typeof interruptTaskOnce>) {
  const [owner, chat, dependencies] = args;
  let controls = pending.get(dependencies.repository);
  if (!controls) pending.set(dependencies.repository, (controls = new Map()));
  const key = JSON.stringify([owner, chat]);
  const prior = controls.get(key);
  if (prior) return prior;
  const result = interruptTaskOnce(...args);
  controls.set(key, result);
  const cleanup = () => {
    if (controls.get(key) === result) controls.delete(key);
  };
  void result.then(cleanup, cleanup);
  return result;
}
