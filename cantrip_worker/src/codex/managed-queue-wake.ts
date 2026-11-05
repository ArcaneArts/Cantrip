import type { ManagedQueueSnapshot } from "@cantrip/protocol";
import type { CodexAppServer } from "./app-server.js";

export function eligibleManagedQueueItem(snapshot: ManagedQueueSnapshot) {
  return snapshot.items.find(
    (item) =>
      !item.frozen &&
      item.state === "pending" &&
      !snapshot.claims.some(
        (claim) =>
          claim.promptId === item.id &&
          claim.promptRevision === item.revision &&
          claim.status === "rejected",
      ),
  );
}

/** The canonical dispatcher owns queued input. An idle wake may resume a native
 * goal only when that queue is clear and neither Pause nor Stop is in effect.
 * Native wake itself never rebinds an explicitly invalidated runner. */
export async function wakeManagedQueueAutonomy(options: {
  snapshot: ManagedQueueSnapshot;
  runtime: Pick<CodexAppServer, "wakeManagedExecution">;
  threadId: string;
  runtimeGeneration: string;
  runner: { runnerGeneration: string } | undefined;
}): Promise<void> {
  // The acknowledged Goal setter already owns the next input. A transfer can
  // retire its unused first attempt while retaining that claim; later prompts
  // must not prevent the corresponding native Goal from requesting a new one.
  const awaitingGoal = options.snapshot.claims.some(
    (claim) =>
      claim.awaitingGoal &&
      claim.goalEpoch &&
      claim.operationId &&
      claim.operationGeneration &&
      !claim.goalOperationId &&
      !claim.goalOperationGeneration &&
      !claim.nativeTurnId &&
      (claim.status === "dispatched" || claim.status === "uncertain"),
  );
  if (
    options.snapshot.paused ||
    (eligibleManagedQueueItem(options.snapshot) && !awaitingGoal) ||
    !options.runner
  )
    return;
  await options.runtime.wakeManagedExecution(
    { threadId: options.threadId, ...options.runner },
    options.runtimeGeneration,
  );
}
