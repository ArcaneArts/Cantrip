import { useSyncExternalStore } from "react";
import type { ExplorerFileMode } from "@cantrip/protocol";

const prefix = "cantrip:editors:v1:";
const eventName = "cantrip:editor-preferences-changed";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  window.localStorage.setItem(prefix + key, value);
  window.dispatchEvent(new Event(eventName));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(prefix)) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(eventName, listener);
  };
}

export function readEditorOpeningMode(
  viewer: string,
  fallback: ExplorerFileMode,
  modes: readonly ExplorerFileMode[],
): ExplorerFileMode {
  const saved = read(`mode:${viewer}`);
  return modes.find((mode) => mode === saved) ?? fallback;
}

export function saveEditorOpeningMode(
  viewer: string,
  mode: ExplorerFileMode,
): void {
  save(`mode:${viewer}`, mode);
}

export function useEditorOpeningMode(
  viewer: string,
  fallback: ExplorerFileMode,
  modes: readonly ExplorerFileMode[],
): ExplorerFileMode {
  return useSyncExternalStore(
    subscribe,
    () => readEditorOpeningMode(viewer, fallback, modes),
    () => fallback,
  );
}

export const editorBooleanDefaults = {
  "nbt-view-mode": true,
  "image-fit": true,
  "audio-loop": false,
  "video-loop": false,
} as const;
export type EditorBooleanPreference = keyof typeof editorBooleanDefaults;

export function readEditorBoolean(key: EditorBooleanPreference): boolean {
  const value = read(key);
  return value === "true" || value === "false"
    ? value === "true"
    : editorBooleanDefaults[key];
}

export function saveEditorBoolean(
  key: EditorBooleanPreference,
  enabled: boolean,
): void {
  save(key, String(enabled));
}

export function useEditorBoolean(key: EditorBooleanPreference): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readEditorBoolean(key),
    () => editorBooleanDefaults[key],
  );
}
