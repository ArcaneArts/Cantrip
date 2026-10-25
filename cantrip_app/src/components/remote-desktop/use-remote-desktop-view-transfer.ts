import { useCallback, useEffect, useRef, useState } from "react";
import { registerRemoteDesktopTransferLifecycle } from "./remote-desktop-transfer-lifecycle";
import {
  parseRemoteDesktopViewState,
  type RemoteDesktopTransferOwner,
  type RemoteDesktopTransferStaging,
  type RemoteDesktopViewState,
} from "./remote-desktop-view-state";

/** Owns a renderer attachment, never the underlying worker desktop session. */
export function useRemoteDesktopViewTransfer(options: {
  owner?: RemoteDesktopTransferOwner;
  state?: RemoteDesktopViewState;
  staging?: RemoteDesktopTransferStaging;
  capture(): RemoteDesktopViewState;
  restore(state: RemoteDesktopViewState): void;
  cancelInput(): void;
  drain(): Promise<void>;
  detach(): void;
  retry(): void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const held = useRef(false);
  const [suspended, setSuspended] = useState(false);
  const [retired, setRetired] = useState(false);
  const restored = useRef<RemoteDesktopViewState | undefined>(undefined);
  const accepting = useCallback(
    () => !held.current && !callbacks.current.staging,
    [],
  );
  const { owner, state, staging } = options;

  useEffect(() => {
    if (!owner || staging) return;
    let live = true;
    let generation = 0;
    let detached = false;
    const assertHeld = (expected: number) => {
      if (!live || !held.current || expected !== generation)
        throw new Error("Remote desktop transfer was cancelled.");
    };
    const unregister = registerRemoteDesktopTransferLifecycle(owner, {
      suspendTransfer() {
        if (held.current)
          throw new Error("Remote desktop is already transferring.");
        callbacks.current.cancelInput();
        held.current = true;
        const current = ++generation;
        setSuspended(true);
        let released = false;
        return () => {
          if (!live || released || current !== generation) return;
          released = true;
          held.current = false;
          generation++;
          setSuspended(false);
          if (detached) {
            detached = false;
            setRetired(false);
            callbacks.current.retry();
          }
        };
      },
      async captureTransfer() {
        const current = generation;
        assertHeld(current);
        await callbacks.current.drain();
        assertHeld(current);
        return parseRemoteDesktopViewState(callbacks.current.capture(), owner);
      },
      async retireTransfer() {
        const current = generation;
        assertHeld(current);
        await callbacks.current.drain();
        assertHeld(current);
        callbacks.current.detach();
        detached = true;
        setRetired(true);
      },
    });
    return () => {
      live = false;
      generation++;
      held.current = false;
      unregister();
    };
  }, [
    owner?.tabId,
    owner?.desktopId,
    owner?.projectId,
    owner?.workerId,
    Boolean(staging),
  ]);

  useEffect(() => {
    if (!staging || !owner) return;
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      try {
        const validated = parseRemoteDesktopViewState(state, owner);
        if (restored.current !== state) {
          callbacks.current.restore(validated);
          restored.current = state;
        }
        if (live) staging.onRestored();
      } catch (error) {
        if (live) staging.onError(error);
      }
    });
    return () => {
      live = false;
    };
  }, [
    state,
    staging,
    owner?.tabId,
    owner?.desktopId,
    owner?.projectId,
    owner?.workerId,
  ]);

  return {
    accepting,
    locked: Boolean(staging) || suspended,
    attachEnabled: !staging && !retired,
  };
}
