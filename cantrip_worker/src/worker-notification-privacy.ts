import type { WorkerNotification } from "@cantrip/protocol";

/** Individual file names belong only on the encrypted observation stream.
 * The server needs the worktree identity to invalidate listings, not its files. */
export function serverWorkerNotification(
  notification: WorkerNotification,
): WorkerNotification {
  if (notification.type !== "worktree.filesystem.changed") return notification;
  const { changes: _changes, ...invalidation } = notification;
  return invalidation;
}
