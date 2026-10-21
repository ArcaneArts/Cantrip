import { useSyncExternalStore } from "react";

const key = "cantrip:file-change-shimmer:v1";
const eventName = "cantrip:file-change-shimmer-changed";
export function readFileChangeShimmer(): boolean {
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}
export function saveFileChangeShimmer(enabled: boolean): void {
  window.localStorage.setItem(key, String(enabled));
  window.dispatchEvent(new Event(eventName));
}
function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}
export function useFileChangeShimmer(): boolean {
  return useSyncExternalStore(subscribe, readFileChangeShimmer, () => true);
}
