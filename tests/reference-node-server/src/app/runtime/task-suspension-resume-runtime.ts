import {
  chatNativeSuspension,
  taskPauseRuntimeStateSchema,
  type ChatPauseRuntimeState,
  type NativeSuspensionRecord,
  type TaskPauseIntent,
} from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import {
  TaskDispatchConflictError,
  type TaskDispatchResumeEligibilityResolver,
} from "../../db/task-dispatch.js";
import type { createTaskClaimedExecutionRuntime } from "./task-claimed-execution-runtime.js";
import { isDeepStrictEqual } from "node:util";

export type ResumeTaskSuspension = (
  owner: string,
  chat: string,
  state: NativeSuspensionRecord,
  intent: TaskPauseIntent,
) => Promise<ChatPauseRuntimeState>;

/** Explicit user controls own this coordination. Reconnection and the ordinary
 * Task scheduler cannot mint a restoration receipt or restart its input. */
export function createTaskSuspensionResumeRuntime(ports: {
  repository: ServerRepository;
  bridge: Pick<WorkerCommandBus, "request">;
  leaseOwner: string;
  eligibility(owner: string): Promise<TaskDispatchResumeEligibilityResolver>;
  run: ReturnType<
    typeof createTaskClaimedExecutionRuntime
  >["runClaimedTaskOperation"];
  publish(chat: string, project: string | null): void;
}): ResumeTaskSuspension {
  const pending = new Map<
    string,
    { controlId: string; result: Promise<ChatPauseRuntimeState> }
  >();
  const execute: ResumeTaskSuspension = async (
    owner,
    chat,
    expected,
    intent,
  ) => {
    const receipt = taskPauseRuntimeStateSchema.parse(
      await ports.bridge.request(
        intent.scope.workerId,
        {
          type: "chat.pause.set",
          chatId: chat,
          paused: false,
          task: intent.scope,
        },
        { ownerId: owner, timeoutMs: null },
      ),
    );
    if (receipt.paused)
      throw new Error("A newer Task pause superseded Resume.");
    if (receipt.active && receipt.execution) {
      if (expected.phase === "running") {
        if (
          !isDeepStrictEqual(expected.actor, receipt.execution.actor) ||
          !isDeepStrictEqual(expected.active, receipt.active)
        )
          throw new Error(
            "The running Task changed its native execution owner.",
          );
        return {
          paused: false,
          active: receipt.active,
          nativeSuspension: chatNativeSuspension(expected),
        };
      }
      const claimed = (
        await ports.repository.nativeSuspensions.claim(
          owner,
          chat,
          expected.controlId,
          expected.actor,
          receipt.execution.actor,
          receipt.active,
        )
      ).state;
      const state = (
        await ports.repository.nativeSuspensions.running(
          owner,
          chat,
          claimed.controlId,
          receipt.execution.actor,
        )
      ).state;
      ports.publish(chat, state.target.projectId);
      return {
        paused: false,
        active: state.active,
        nativeSuspension: chatNativeSuspension(state),
      };
    }
    if (receipt.active)
      throw new Error(
        "The Task Resume did not acknowledge its canonical native owner.",
      );
    const restore = await ports.repository.nativeSuspensions.taskResumption(
      owner,
      chat,
      expected.controlId,
    );
    const claim = await ports.repository.taskDispatch.resumeNextPaused(
      owner,
      ports.leaseOwner,
      await ports.eligibility(owner),
      { nativeSuspension: { chatId: chat, controlId: expected.controlId } },
    );
    if (!claim)
      throw new Error(
        "The paused Task could not acquire its current dispatch lease.",
      );
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void ready.catch(() => {});
    try {
      await ports.run(owner, claim, null, {
        restore,
        onResumed: resolve,
        onFailed: reject,
      });
      await ready;
      const state = await ports.repository.nativeSuspensions.read(owner, chat);
      if (!state)
        throw new Error("The Task Resume acknowledgement disappeared.");
      const intent = await ports.repository.taskAutomationPause.read(
        owner,
        chat,
      );
      ports.publish(chat, state.target.projectId);
      return {
        paused: intent?.paused ?? true,
        active: state.active,
        nativeSuspension: chatNativeSuspension(state),
      };
    } catch (error) {
      try {
        await ports.repository.taskDispatch.pause(claim.lease, {
          threadId: restore.checkpoint.suspension.threadId,
          turnId: restore.checkpoint.suspension.turnId,
        });
      } catch (failure) {
        if (!(failure instanceof TaskDispatchConflictError)) throw failure;
      }
      throw error;
    }
  };
  return (owner, chat, state, intent) => {
    const key = JSON.stringify([owner, chat]);
    const prior = pending.get(key);
    if (prior?.controlId === state.controlId) return prior.result;
    const result = Promise.resolve(prior?.result)
      .catch(() => {})
      .then(() => execute(owner, chat, state, intent));
    const entry = { controlId: state.controlId, result };
    pending.set(key, entry);
    const cleanup = () => {
      if (pending.get(key) === entry) pending.delete(key);
    };
    void result.then(cleanup, cleanup);
    return result;
  };
}
