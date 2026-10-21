import type { WorkerNotification } from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";

type FilesystemNotification = Extract<
  WorkerNotification,
  { type: "worktree.filesystem.changed" }
>;
export type FileChange = NonNullable<FilesystemNotification["changes"]>[number];
export interface FileChangeActivity {
  workerId: string;
  notification: FilesystemNotification;
}
const listeners = new WeakMap<
  QueryClient,
  Set<(activity: FileChangeActivity) => void>
>();

export function publishFileChangeActivity(
  client: QueryClient,
  activity: FileChangeActivity,
): void {
  for (const listener of listeners.get(client) ?? []) listener(activity);
}

export function subscribeFileChangeActivity(
  client: QueryClient,
  listener: (activity: FileChangeActivity) => void,
): () => void {
  let subscribers = listeners.get(client);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(client, subscribers);
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Collapse a batch onto its nearest visible names. Mixed changes in one folder
 * use yellow; deleted entries always resolve to a surviving ancestor. */
export function visibleFileChanges(
  changes: readonly FileChange[],
  visiblePaths: ReadonlySet<string>,
): Map<string, FileChange["kind"]> {
  const deleted = new Set(
    changes
      .filter((change) => change.kind === "deleted")
      .map((change) => change.path),
  );
  const result = new Map<string, FileChange["kind"]>();
  for (const change of changes) {
    const parts = change.path.replaceAll("\\", "/").split("/");
    if (parts.some((part) => part === ".." || part === ".git")) continue;
    let target = parts.join("/");
    while (!visiblePaths.has(target) || deleted.has(target)) {
      if (!parts.length) break;
      parts.pop();
      target = parts.join("/");
    }
    if (!visiblePaths.has(target)) continue;
    const previous = result.get(target);
    result.set(
      target,
      previous && previous !== change.kind ? "modified" : change.kind,
    );
  }
  return result;
}
