import { useEffect, useRef, useState } from "react";
import { registerChatTransferLifecycle } from "./chat-transfer-lifecycle";
import {
  parseChatViewState,
  type ChatTransferOwner,
  type ChatViewState,
  type IncomingChatView,
} from "./chat-view-state";

/** Coordinates view ownership only. Never interrupts or archives chat execution. */
export function useChatViewTransfer({
  owner,
  incoming,
  capture,
  restore,
  flush,
}: {
  owner?: ChatTransferOwner;
  incoming?: IncomingChatView;
  capture(): ChatViewState;
  restore(state: ChatViewState, signal: AbortSignal): Promise<void>;
  flush(): Promise<void>;
}) {
  const callbacks = useRef({ capture, restore, flush });
  callbacks.current = { capture, restore, flush };
  const [suspended, setSuspended] = useState(false);
  const restored = useRef<ChatViewState | null>(null);
  const staging = Boolean(incoming?.staging);
  useEffect(() => {
    if (!owner || staging) return;
    let live = true;
    let holds = 0;
    let retired = false;
    const unregister = registerChatTransferLifecycle(owner, {
      suspendTransfer() {
        holds++;
        setSuspended(true);
        let released = false;
        return () => {
          if (!live || released) return;
          released = true;
          holds--;
          // A cancelled ownership commit restores the same source renderer.
          retired = false;
          setSuspended(holds > 0);
        };
      },
      async captureTransfer() {
        if (!holds || retired)
          throw new Error("Chat view is not suspended for capture.");
        await callbacks.current.flush();
        if (!live || !holds || retired)
          throw new Error("Chat capture was cancelled.");
        return parseChatViewState(callbacks.current.capture(), owner);
      },
      async retireTransfer() {
        if (!holds)
          throw new Error("Chat view is not suspended for retirement.");
        await callbacks.current.flush();
        if (!live || !holds) throw new Error("Chat retirement was cancelled.");
        retired = true;
        setSuspended(true);
      },
    });
    return () => {
      live = false;
      unregister();
    };
  }, [owner?.tabId, owner?.chatId, owner?.projectId, staging]);

  useEffect(() => {
    if (!incoming?.staging || !owner) return;
    const controller = new AbortController();
    const { state, staging: acknowledgment } = incoming;
    void (async () => {
      try {
        const validated = parseChatViewState(state, owner);
        if (restored.current !== state) {
          await callbacks.current.restore(validated, controller.signal);
          controller.signal.throwIfAborted();
          restored.current = state;
        }
        if (!controller.signal.aborted) acknowledgment.onRestored();
      } catch (error) {
        if (!controller.signal.aborted) acknowledgment.onError(error);
      }
    })();
    return () => controller.abort();
  }, [
    incoming?.state,
    incoming?.staging,
    owner?.tabId,
    owner?.chatId,
    owner?.projectId,
  ]);

  return { transferLocked: staging || suspended };
}
