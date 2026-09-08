import { EventEmitter } from "node:events";
import type { ServerRepository } from "../../db/repository.js";
import type { NativeCommandSession } from "@cantrip/protocol";
const receipts = new EventEmitter();
receipts.setMaxListeners(0);
export function notifyManagedQueueReceipt(chatId: string) {
  receipts.emit(chatId);
}
/** Notifications accelerate reads; periodic real reads cover another server instance and lost notifications. */
export async function waitForManagedQueueReceipt(
  repository: Pick<ServerRepository, "managedQueue">,
  ownerId: string,
  workerId: string,
  session: NativeCommandSession,
  claimId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let wake: (() => void) | null = null;
  const changed = () => wake?.();
  receipts.on(session.chatId, changed);
  signal.addEventListener("abort", changed);
  try {
    for (;;) {
      signal.throwIfAborted();
      let changedWhileReading = false;
      wake = () => {
        changedWhileReading = true;
      };
      const value = await repository.managedQueue.startReceipt(
        ownerId,
        workerId,
        session,
        claimId,
      );
      if (value) return value;
      signal.throwIfAborted();
      if (changedWhileReading) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, 750);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        if (signal.aborted) wake();
      });
    }
  } finally {
    wake = null;
    receipts.off(session.chatId, changed);
    signal.removeEventListener("abort", changed);
  }
}
