import type { NativeHistoryItemIdentity } from "@cantrip/protocol";
import type { CodexNativeHistorySnapshot } from "./codex/native-history.js";
import { resolveNativeHistoryTurnContext } from "./native-history-turn-context.js";

/** Live encryption and replay must classify the same native item identically.
 * Read original turn evidence, never the latest GUI settings. This only delays
 * publication; it neither gates nor repeats native input. Cache successful reads
 * for this sealer's lifetime and allow failed observations to be retried. */
export function createNativeHistoryOutputModeResolver(
  read: (threadId: string) => Promise<CodexNativeHistorySnapshot>,
) {
  const modes = new Map<string, Promise<"default" | "plan">>();
  return (identity: NativeHistoryItemIdentity): Promise<"default" | "plan"> => {
    const key = JSON.stringify([identity.threadId, identity.turnId]);
    let pending = modes.get(key);
    if (!pending) {
      pending = (async () => {
        const snapshot = await read(identity.threadId);
        if (snapshot.thread.id !== identity.threadId)
          throw new Error("Native output mode belongs to another thread.");
        const turn = snapshot.history?.turns.find(
          (turn) => turn.turnId === identity.turnId,
        );
        return resolveNativeHistoryTurnContext(turn?.contexts ?? []).mode;
      })();
      modes.set(key, pending);
      const attempt = pending;
      void attempt.catch(() => {
        if (modes.get(key) === attempt) modes.delete(key);
      });
    }
    return pending;
  };
}
