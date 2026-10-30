import { useSyncExternalStore } from "react";

const key = "cantrip:code-editor-line-numbers:v1";
const eventName = "cantrip:code-editor-preferences-changed";

export function readCodeEditorLineNumbers(): boolean {
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

export function saveCodeEditorLineNumbers(enabled: boolean): void {
  window.localStorage.setItem(key, String(enabled));
  window.dispatchEvent(new Event(eventName));
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(eventName, listener);
  };
}

export function useCodeEditorLineNumbers(): boolean {
  return useSyncExternalStore(subscribe, readCodeEditorLineNumbers, () => true);
}
