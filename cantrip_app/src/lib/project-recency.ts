import { useMemo, useSyncExternalStore } from "react";

import {
  getClientSession,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";

const changedEvent = "cantrip:project-recency-changed";
const emptyHistory = "[]";
const fallbackHistories = new Map<string, string>();

function storageKey(): string | null {
  const session = getClientSession();
  return session
    ? JSON.stringify([
        "cantrip:project-recency:v1",
        session.serverId,
        session.user.id,
      ])
    : null;
}

function snapshot(key = storageKey()): string {
  if (!key) return emptyHistory;
  const cached = fallbackHistories.get(key);
  if (cached !== undefined) return cached;
  let value = emptyHistory;
  try {
    value = window.localStorage.getItem(key) ?? emptyHistory;
  } catch {
    // Keep navigation usable when browser storage is unavailable.
  }
  return value;
}

function parseHistory(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function readRecentProjectIds(): string[] {
  return parseHistory(snapshot());
}

export function recordProjectAccess(projectId: string): void {
  const key = storageKey();
  if (!key || typeof window === "undefined") return;
  const previous = parseHistory(snapshot(key));
  if (previous[0] === projectId) return;
  const value = JSON.stringify([
    projectId,
    ...previous.filter((id) => id !== projectId),
  ]);
  fallbackHistories.set(key, value);
  try {
    window.localStorage.setItem(key, value);
    fallbackHistories.delete(key);
  } catch {
    // The in-memory history still orders this session when persistence fails.
  }
  window.dispatchEvent(new Event(changedEvent));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null) fallbackHistories.clear();
    else fallbackHistories.delete(event.key);
    listener();
  };
  const unsubscribeIdentity = onClientSessionIdentityChanged(listener);
  window.addEventListener("storage", storageChanged);
  window.addEventListener(changedEvent, listener);
  return () => {
    unsubscribeIdentity();
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener(changedEvent, listener);
  };
}

export function useRecentProjectIds(): string[] {
  const value = useSyncExternalStore(subscribe, snapshot, () => emptyHistory);
  return useMemo(() => parseHistory(value), [value]);
}
