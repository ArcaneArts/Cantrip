import { FolderOpen, FolderRoot, type LucideProps } from "lucide-react";
import { useSyncExternalStore } from "react";

const subscribers = new Set<() => void>();
let shiftKeyHeld = false;
let detachWindowListeners: (() => void) | null = null;

function publishShiftKeyHeld(next: boolean): void {
  if (shiftKeyHeld === next) return;
  shiftKeyHeld = next;
  for (const subscriber of subscribers) subscriber();
}

function attachWindowListeners(): () => void {
  if (typeof window === "undefined") return () => undefined;

  const update = (event: Event) => {
    if ("shiftKey" in event && typeof event.shiftKey === "boolean") {
      publishShiftKeyHeld(event.shiftKey);
    }
  };
  const reset = () => publishShiftKeyHeld(false);
  const resetWhenHidden = () => {
    if (typeof document !== "undefined" && document.hidden) reset();
  };

  window.addEventListener("keydown", update, true);
  window.addEventListener("keyup", update, true);
  window.addEventListener("mousemove", update, true);
  window.addEventListener("mousedown", update, true);
  window.addEventListener("mouseup", update, true);
  window.addEventListener("contextmenu", update, true);
  window.addEventListener("blur", reset);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", resetWhenHidden);
  }

  return () => {
    window.removeEventListener("keydown", update, true);
    window.removeEventListener("keyup", update, true);
    window.removeEventListener("mousemove", update, true);
    window.removeEventListener("mousedown", update, true);
    window.removeEventListener("mouseup", update, true);
    window.removeEventListener("contextmenu", update, true);
    window.removeEventListener("blur", reset);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", resetWhenHidden);
    }
  };
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) detachWindowListeners = attachWindowListeners();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size !== 0) return;
    detachWindowListeners?.();
    detachWindowListeners = null;
    shiftKeyHeld = false;
  };
}

function snapshot(): boolean {
  return shiftKeyHeld;
}

export function useShiftKeyHeld(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function NativeFolderRevealIcon({
  localFolder,
  ...props
}: LucideProps & { localFolder: boolean }) {
  const Icon = localFolder ? FolderRoot : FolderOpen;
  return (
    <Icon
      aria-hidden="true"
      data-native-folder-reveal={localFolder ? "local" : "network"}
      {...props}
    />
  );
}
