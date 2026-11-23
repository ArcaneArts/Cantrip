import type { NativeHistoryItemIdentity } from "@cantrip/protocol";
import type { CodexNativeHistorySnapshot } from "./codex/native-history.js";
import {
  NativeHistoryTurnContextPending,
  resolveNativeHistoryTurnContext,
} from "./native-history-turn-context.js";
import type {
  NativeHistoryObserver,
  NativeHistorySubscription,
} from "./codex/native-history-observation.js";

type Observe = (
  threadId: string,
  observer: NativeHistoryObserver,
) => NativeHistorySubscription;

async function originalMode(
  identity: NativeHistoryItemIdentity,
  read: (threadId: string) => Promise<CodexNativeHistorySnapshot>,
  observe?: Observe,
): Promise<"default" | "plan"> {
  let revision = 0,
    wake: (() => void) | undefined,
    failure: { error: unknown } | undefined;
  const subscription = observe?.(identity.threadId, {
    capture: (event) => {
      if (event.method === "thread/closed")
        failure = {
          error: new Error(
            "Native thread closed before original output context was retained.",
          ),
        };
      revision++;
      wake?.();
    },
    onError: (error) => {
      failure = { error };
      wake?.();
    },
  });
  const changed = () => wake?.();
  subscription?.signal.addEventListener("abort", changed);
  const assertCurrent = () => {
    subscription?.signal.throwIfAborted();
    if (failure) throw failure.error;
  };
  try {
    for (;;) {
      assertCurrent();
      const before = revision;
      const snapshot = subscription
        ? (await subscription.readSnapshot()).snapshot
        : await read(identity.threadId);
      assertCurrent();
      if (snapshot.thread.id !== identity.threadId)
        throw new Error("Native output mode belongs to another thread.");
      const turn = snapshot.history?.turns.find(
        (turn) => turn.turnId === identity.turnId,
      );
      try {
        return resolveNativeHistoryTurnContext(turn?.contexts ?? []).mode;
      } catch (error) {
        if (
          !subscription ||
          !(error instanceof NativeHistoryTurnContextPending)
        )
          throw error;
      }
      // Compaction can emit an item before retaining its turn context. Observe
      // actual native history changes and reread original evidence; do not guess
      // from current settings, block native input or lose this ordered output.
      if (revision === before)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
    }
  } finally {
    subscription?.signal.removeEventListener("abort", changed);
    subscription?.close();
  }
}

/** Live encryption and replay must classify the same native item identically.
 * Read original turn evidence, never the latest GUI settings. This only delays
 * publication; it neither gates nor repeats native input. Cache successful reads
 * for this sealer's lifetime and allow failed observations to be retried. */
export function createNativeHistoryOutputModeResolver(
  read: (threadId: string) => Promise<CodexNativeHistorySnapshot>,
  observe?: Observe,
) {
  const modes = new Map<string, Promise<"default" | "plan">>();
  return (identity: NativeHistoryItemIdentity): Promise<"default" | "plan"> => {
    const key = JSON.stringify([identity.threadId, identity.turnId]);
    let pending = modes.get(key);
    if (!pending) {
      pending = originalMode(identity, read, observe);
      modes.set(key, pending);
      const attempt = pending;
      void attempt.catch(() => {
        if (modes.get(key) === attempt) modes.delete(key);
      });
    }
    return pending;
  };
}
