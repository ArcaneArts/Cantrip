import { useSyncExternalStore } from "react";

export type ProjectSidebarPage = "files" | "conversations";
const key = "cantrip:project-sidebar-page:v2";
const eventName = "cantrip:project-sidebar-page";
let fallback: ProjectSidebarPage | null = null;

function subscribe(listener: () => void) {
  const changed = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    fallback = null;
    listener();
  };
  window.addEventListener(eventName, listener);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("storage", changed);
  };
}

function read(): ProjectSidebarPage {
  if (fallback) return fallback;
  try {
    return window.localStorage.getItem(key) === "conversations"
      ? "conversations"
      : "files";
  } catch {
    return "files";
  }
}

function setPage(page: ProjectSidebarPage) {
  fallback = page;
  try {
    window.localStorage.setItem(key, page);
    fallback = null;
  } catch {
    /* Keep the choice for this window if storage is unavailable. */
  }
  window.dispatchEvent(new Event(eventName));
}

export function useProjectSidebarPage() {
  const page = useSyncExternalStore(subscribe, read, () => "files" as const);
  return { page, setPage };
}
