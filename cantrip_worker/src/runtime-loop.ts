export type WorkerRuntimeOutcome = "restart" | "stop";

export const WORKER_RESTART_SETTLE_MS = 250;

export function scheduleWorkerRuntimeRestart(
  restart: () => void,
  delayMs = WORKER_RESTART_SETTLE_MS,
): () => void {
  const timer = setTimeout(restart, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export async function runWorkerRuntimeLoop(
  runOnce: () => Promise<WorkerRuntimeOutcome>,
): Promise<void> {
  while ((await runOnce()) === "restart") {
    // The previous runtime completed its graceful shutdown before another
    // runtime is created with the same durable worker identity.
  }
}
