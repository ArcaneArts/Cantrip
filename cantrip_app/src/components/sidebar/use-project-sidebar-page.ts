import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";

export type ProjectSidebarPage = "files" | "conversations";
const eventName = "cantrip:project-sidebar-page";
const fallback = new Map<string, ProjectSidebarPage>();
function subscribe(listener: () => void) {
  const off = onClientSessionIdentityChanged(listener);
  const changed = (event: StorageEvent) => {
    if (event.key) fallback.delete(event.key);
    else fallback.clear();
    listener();
  };
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", changed);
  return () => {
    off();
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", changed);
  };
}
function sessionScope(projectId: string | null) {
  const identity = getClientSessionIdentitySnapshot();
  return identity && projectId
    ? JSON.stringify([identity.serverId, identity.userId, projectId])
    : null;
}
function read(key: string | null): ProjectSidebarPage {
  if (!key) return "files";
  const memory = fallback.get(key);
  if (memory) return memory;
  try {
    return window.localStorage.getItem(key) === "conversations"
      ? "conversations"
      : "files";
  } catch {
    return "files";
  }
}
function write(key: string, page: ProjectSidebarPage) {
  fallback.set(key, page);
  try {
    window.localStorage.setItem(key, page);
    fallback.delete(key);
  } catch {
    /* Retain this session's choice if storage is unavailable. */
  }
  window.dispatchEvent(new Event(eventName));
}

/** The workspace ID includes installation/account/server/project, never viewport or login epoch. */
export function useProjectSidebarPage(
  projectId: string | null,
  workspaceId: string | null,
) {
  const scope = useSyncExternalStore(
    subscribe,
    () => sessionScope(projectId),
    () => null,
  );
  const key =
    scope && workspaceId
      ? JSON.stringify(["cantrip:project-sidebar-page:v1", scope, workspaceId])
      : null;
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => "files" as const,
  );
  const [pending, setPending] = useState<{
    scope: string;
    page: ProjectSidebarPage;
  } | null>(null);
  useEffect(() => {
    if (key && pending?.scope === scope) {
      write(key, pending.page);
      setPending(null);
    }
  }, [key, pending, scope]);
  const setPage = useCallback(
    (page: ProjectSidebarPage) => {
      // A delayed callback from another account/project cannot change this scope.
      if (!scope || scope !== sessionScope(projectId)) return;
      if (key) {
        write(key, page);
        setPending(null);
      } else setPending({ scope, page });
    },
    [key, scope, projectId],
  );
  return { page: pending?.scope === scope ? pending.page : stored, setPage };
}
