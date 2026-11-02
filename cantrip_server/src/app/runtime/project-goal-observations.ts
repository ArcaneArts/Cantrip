import { boundManagedRuntime } from "../../terminals/bound-managed-runtime.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

/** Reconcile known native Goals on reconnect, independently of mounted panels.
 * Badge reads only query the projection; they never invoke this worker path. */
export function createProjectGoalReconciler(deps: {
  repository: ServerRepository;
  bridge: WorkerCommandBus;
  runtimeForContext: ReturnType<
    typeof createModelRoutingRuntime
  >["runtimeForContext"];
  onError(): void;
}) {
  return async (owner: string, worker: string, generation: string) => {
    const identity = deps.bridge.connectionIdentity?.(worker);
    if (
      identity &&
      (identity.ownerId !== owner ||
        identity.workerProcessGeneration !== generation)
    )
      return;
    await deps.repository.alerts.registerGoalWorker(owner, worker, generation);
    let after: string | null = null;
    let failed = false;
    for (;;) {
      const chats = await deps.repository.alerts.goalChats(
        owner,
        worker,
        after,
      );
      for (const chatId of chats) {
        try {
          const context = await deps.repository.getChatExecutionContext(
            owner,
            chatId,
          );
          if (
            !context ||
            context.contextKind !== "project" ||
            context.experience !== "agent" ||
            context.workerId !== worker ||
            !context.threadId
          )
            continue;
          const runtime = context.modelRouteId
            ? await boundManagedRuntime(owner, context, deps.repository)
            : await deps.runtimeForContext(context);
          if (!runtime) continue;
          await deps.bridge.request(
            worker,
            {
              type: "chat.goal.get",
              chatId,
              cwd: context.cwd,
              threadId: context.threadId,
              model: runtime.model,
              provider: runtime.provider,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
              protectObjective: true,
            },
            { timeoutMs: 15_000 },
          );
          // The worker's protected observation outbox delivers the captured
          // snapshot with its actual generation/sequence, including a clear.
        } catch {
          failed = true;
        }
      }
      if (chats.length < 100) {
        if (failed) deps.onError();
        return;
      }
      after = chats[chats.length - 1]!;
    }
  };
}
