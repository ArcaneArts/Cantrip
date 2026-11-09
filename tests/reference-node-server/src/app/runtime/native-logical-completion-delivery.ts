import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { FastifyInstance } from "fastify";

export interface NativeLogicalCompletion {
  ownerId: string;
  workerId: string;
  chatId: string;
  rootOperationId: string;
  rootOperationGeneration: string;
  attempts: number;
}

export interface NativeLogicalCompletionOutbox {
  listPendingLogicalCompletions(
    limit: number,
  ): Promise<NativeLogicalCompletion[]>;
  acknowledgeLogicalCompletion(
    ownerId: string,
    workerId: string,
    chatId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
  ): Promise<boolean>;
  deferLogicalCompletion(
    ownerId: string,
    workerId: string,
    chatId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
    nextAttemptAt: Date,
  ): Promise<boolean>;
}

const identity = (entry: NativeLogicalCompletion) =>
  [
    entry.ownerId,
    entry.workerId,
    entry.chatId,
    entry.rootOperationId,
    entry.rootOperationGeneration,
  ] as const;

/** This message releases an exact completed root; it never dispatches input. */
export async function deliverNativeLogicalCompletion(
  entry: NativeLogicalCompletion,
  bridge: Pick<WorkerCommandBus, "request">,
): Promise<void> {
  await bridge.request(
    entry.workerId,
    {
      type: "chat.native-logical.complete",
      chatId: entry.chatId,
      rootOperationId: entry.rootOperationId,
      rootOperationGeneration: entry.rootOperationGeneration,
    },
    { ownerId: entry.ownerId, timeoutMs: 10_000 },
  );
}

/** Retries committed completion messages independently of UI and worker reconnects. */
export function createNativeLogicalCompletionDelivery(options: {
  repository: NativeLogicalCompletionOutbox;
  bridge: Pick<WorkerCommandBus, "request">;
  onError(error: unknown, entry?: NativeLogicalCompletion): void;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const intervalMs = options.intervalMs ?? 1_000;

  const deliver = async (entry: NativeLogicalCompletion) => {
    try {
      await deliverNativeLogicalCompletion(entry, options.bridge);
      if (!stopped)
        await options.repository.acknowledgeLogicalCompletion(
          ...identity(entry),
        );
    } catch (error) {
      if (stopped) return;
      options.onError(error, entry);
      // Persist the retry schedule so an offline worker cannot starve later rows
      // and a server restart does not discard the pending acknowledgment.
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(entry.attempts, 5));
      try {
        await options.repository.deferLogicalCompletion(
          ...identity(entry),
          new Date(Date.now() + delay),
        );
      } catch (retryError) {
        options.onError(retryError, entry);
      }
    }
  };

  const drain = async () => {
    const entries = await options.repository.listPendingLogicalCompletions(64);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (!stopped && next < entries.length) {
          const entry = entries[next++]!;
          await deliver(entry);
        }
      }),
    );
  };

  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = drain()
      .catch((error: unknown) => {
        if (!stopped) options.onError(error);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().finally(schedule);
    }, intervalMs);
    timer.unref();
  };

  return {
    runOnce,
    start() {
      if (stopped) return;
      void runOnce().finally(schedule);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // A request already sent may finish. Keep its row for the next server if
      // shutdown wins the reply race; duplicate exact acknowledgments are safe.
    },
  };
}

/** Registers startup; the application closes this before its worker/database services. */
export function installNativeLogicalCompletionDelivery(options: {
  app: Pick<FastifyInstance, "addHook" | "log">;
  repository: NativeLogicalCompletionOutbox;
  bridge: Pick<WorkerCommandBus, "request">;
}) {
  const delivery = createNativeLogicalCompletionDelivery({
    repository: options.repository,
    bridge: options.bridge,
    onError: (_error, completion) =>
      options.app.log.warn(
        {
          event: "native-command.logical-completion-delivery-failed",
          chatId: completion?.chatId,
          operationId: completion?.rootOperationId,
        },
        "Logical native completion remains pending for redelivery.",
      ),
  });
  options.app.addHook("onReady", async () => delivery.start());
  return delivery;
}
