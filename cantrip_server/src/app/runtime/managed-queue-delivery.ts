import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
/** A durable revision cursor makes lost queue notices recoverable without replaying input. */
export function createManagedQueueDelivery(options: {
  repository: ServerRepository["managedQueue"];
  bridge: Pick<WorkerCommandBus, "request">;
  publish: (ownerId: string, chatId: string) => void;
  onError: (error: unknown) => void;
  dispatch?: (ownerId: string, chatId: string) => Promise<void>;
}) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let recovering: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const runOnce = () => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      if (options.dispatch && !recovering) {
        recovering = (async () => {
          const pending = await options.repository.pendingDispatches();
          let nextDispatch = 0;
          await Promise.all(
            Array.from({ length: Math.min(pending.length, 8) }, async () => {
              while (!stopped && nextDispatch < pending.length) {
                const entry = pending[nextDispatch++]!;
                try {
                  await options.dispatch!(entry.ownerId, entry.chatId);
                } catch (error) {
                  options.onError(error);
                }
              }
            }),
          );
        })()
          .catch(options.onError)
          .finally(() => {
            recovering = undefined;
          });
      }
      const entries = await options.repository.pendingNotifications();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(entries.length, 8) }, async () => {
          while (!stopped && next < entries.length) {
            const entry = entries[next++]!;
            try {
              options.publish(entry.ownerId, entry.chatId);
              await options.bridge.request(
                entry.workerId,
                {
                  type: "chat.queue.changed",
                  chatId: entry.chatId,
                  revision: entry.revision,
                },
                { ownerId: entry.ownerId, timeoutMs: 10000 },
              );
              if (!stopped)
                await options.repository.acknowledgeNotification(
                  entry.chatId,
                  entry.revision,
                );
            } catch (error) {
              options.onError(error);
              if (!stopped)
                await options.repository.deferNotification(entry.chatId);
            }
          }
        }),
      );
    })()
      .catch(options.onError)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  return {
    runOnce,
    start() {
      if (stopped || timer) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), 1000);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
