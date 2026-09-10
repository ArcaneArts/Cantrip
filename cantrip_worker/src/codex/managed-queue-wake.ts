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
  if (
    options.snapshot.paused ||
    eligibleManagedQueueItem(options.snapshot) ||
    !options.runner
  )
    return;
  await options.runtime.wakeManagedExecution(
    { threadId: options.threadId, ...options.runner },
    options.runtimeGeneration,
  );
}
