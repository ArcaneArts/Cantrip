import type { ExplorerSummary } from "@cantrip/protocol";
import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

import {
  getClientSession,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";

const changedEvent = "cantrip:sidebar-folders-changed";
const emptyPaths = "[]";
const fallbackPaths = new Map<string, string>();
type FolderScope = Pick<ExplorerSummary, "projectId" | "worktreeId"> | null;

function storageKey(explorer: FolderScope): string | null {
  const session = getClientSession();
  return session && explorer
    ? JSON.stringify([
        "cantrip:sidebar-folders:v1",
        session.serverId,
        session.user.id,
        explorer.projectId,
        explorer.worktreeId,
      ])
    : null;
}

function snapshot(key: string | null): string {
  if (!key) return emptyPaths;
  const fallback = fallbackPaths.get(key);
  if (fallback !== undefined) return fallback;
  try {
    return window.localStorage.getItem(key) ?? emptyPaths;
  } catch {
    return emptyPaths;
  }
}

function parsePaths(value: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

function subscribe(listener: () => void): () => void {
  const unsubscribeIdentity = onClientSessionIdentityChanged(listener);
  if (typeof window === "undefined") return unsubscribeIdentity;
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null) fallbackPaths.clear();
    else fallbackPaths.delete(event.key);
    listener();
  };
  window.addEventListener("storage", storageChanged);
  window.addEventListener(changedEvent, listener);
  return () => {
    unsubscribeIdentity();
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener(changedEvent, listener);
  };
}

export function useSidebarFolderExpansion(explorer: FolderScope) {
  const key = useSyncExternalStore(
    subscribe,
    () => storageKey(explorer),
    () => null,
  );
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot(key),
    () => emptyPaths,
  );
  const expandedPaths = useMemo(() => parsePaths(value), [value]);
  const autoExpansion = useRef({ key, paths: new Set<string>() });
  if (autoExpansion.current.key !== key) {
    autoExpansion.current = { key, paths: new Set() };
  }

  const setExpandedPaths = useCallback(
    (update: SetStateAction<ReadonlySet<string>>) => {
      if (!key) return;
      const current = parsePaths(snapshot(key));
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      const nextValue = JSON.stringify([...next]);
      if (nextValue === snapshot(key)) return;
      // Save on the interaction, without waiting for an effect or unmount.
      fallbackPaths.set(key, nextValue);
      try {
        window.localStorage.setItem(key, nextValue);
        fallbackPaths.delete(key);
      } catch {
        // Switching projects still remembers folders if persistent storage fails.
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(changedEvent));
      }
    },
    [key],
  );

  const toggle = useCallback(
    (path: string) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
          for (const candidate of autoExpansion.current.paths) {
            if (candidate === path || candidate.startsWith(`${path}/`)) {
              autoExpansion.current.paths.delete(candidate);
            }
          }
        } else {
          next.add(path);
          autoExpansion.current.paths.add(path);
        }
        return next;
      });
    },
    [setExpandedPaths],
  );

  const expandChild = useCallback(
    (parentPath: string, path: string) => {
      // Only a user expansion starts automatic single-child traversal. Restoring
      // a saved parent must not reopen a child the user deliberately collapsed.
      if (!autoExpansion.current.paths.has(parentPath)) return;
      setExpandedPaths((current) => {
        if (!current.has(parentPath) || current.has(path)) return current;
        autoExpansion.current.paths.add(path);
        return new Set([...current, path]);
      });
    },
    [setExpandedPaths],
  );

  return { expandedPaths, setExpandedPaths, toggle, expandChild };
}
