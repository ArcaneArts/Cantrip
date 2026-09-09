import type {
  NativeHistoryPublication,
  NativeHistoryPublicationRepository,
} from "../../db/repository/native-history-publications.js";

/** Committed history repairs the UI independently of native activity or reconnect. */
export function createNativeHistoryPublicationDelivery(options: {
  repository: Pick<
    NativeHistoryPublicationRepository,
    "listPending" | "acknowledge" | "defer"
  >;
  publish(entry: NativeHistoryPublication): Promise<void>;
  onError(error: unknown, entry?: NativeHistoryPublication): void;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const intervalMs = options.intervalMs ?? 1_000;
  const report = (error: unknown, entry?: NativeHistoryPublication) => {
    try {
      options.onError(error, entry);
    } catch {
      /* Diagnostics cannot consume dirty work. */
    }
  };
  const deliver = async (entry: NativeHistoryPublication) => {
    try {
      await options.publish(entry);
      if (!stopped) await options.repository.acknowledge(entry);
    } catch (error) {
      if (stopped) return;
      report(error, entry);
      try {
        await options.repository.defer(
          entry,
          new Date(
            Date.now() +
              Math.min(30_000, 1_000 * 2 ** Math.min(entry.attempts, 5)),
          ),
        );
      } catch (deferError) {
        report(deferError, entry);
      }
    }
  };
  const drain = async () => {
    const entries = await options.repository.listPending(64);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (!stopped && next < entries.length)
          await deliver(entries[next++]!);
      }),
    );
  };
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = drain()
      .catch((error) => {
        if (!stopped) report(error);
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
      if (!stopped) void runOnce().finally(schedule);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
