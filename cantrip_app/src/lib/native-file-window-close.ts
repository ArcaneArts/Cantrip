import { isTauri } from "@tauri-apps/api/core";

export interface NativeFileCloseEvent {
  preventDefault(): void;
}
export interface NativeFileCloseWindow {
  onCloseRequested(
    handler: (event: NativeFileCloseEvent) => Promise<void>,
  ): Promise<() => void>;
  destroy(): Promise<void>;
}

/** Own the close decision: the SDK must not destroy a window after cancellation. */
export function bindNativeFileWindowClose(
  window: NativeFileCloseWindow,
  hasUnsavedChanges: () => boolean,
  confirmDiscard: () => Promise<boolean>,
  onError: (error: unknown) => void,
): { ready: Promise<void>; dispose(): void } {
  let disposed = false;
  let closing = false;
  let destroyed = false;
  let unlisten: (() => void) | undefined;
  const ready = window
    .onCloseRequested(async (event) => {
      // Tauri's helper otherwise calls destroy() itself after awaiting us.
      event.preventDefault();
      if (disposed || closing) return;
      closing = true;
      try {
        if (hasUnsavedChanges() && !(await confirmDiscard())) return;
        if (!disposed) {
          await window.destroy();
          destroyed = true;
        }
      } catch (error) {
        if (!disposed) onError(error);
      } finally {
        closing = destroyed;
      }
    })
    .then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    })
    .catch((error: unknown) => {
      if (!disposed) onError(error);
    });
  return {
    ready,
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    },
  };
}
/** Private data is cleared by the owner before an account-revoked window closes. */
export async function closeRevokedNativeFileWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}
