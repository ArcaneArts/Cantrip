import type { TaskDispatchWorkerLease } from "@cantrip/protocol";

import { TASK_DISPATCH_LEASE_MS } from "../db/task-dispatch.js";

interface TaskDispatchLeaseRetentionOptions<T> {
  heartbeat: (lease: TaskDispatchWorkerLease) => Promise<unknown>;
  lease: TaskDispatchWorkerLease;
  onHeartbeatError: (error: unknown) => void;
  operation: () => Promise<T>;
  intervalMs?: number;
}

/**
 * Keeps a claimed Task dispatch fenced while launch preflight is still
 * running. The normal turn heartbeat takes over once the operation returns.
 */
export async function withTaskDispatchLeaseRetention<T>({
  heartbeat,
  lease,
  onHeartbeatError,
  operation,
  intervalMs = Math.floor(TASK_DISPATCH_LEASE_MS / 3),
}: TaskDispatchLeaseRetentionOptions<T>): Promise<T> {
  let heartbeatActive = false;
  const timer = setInterval(() => {
    if (heartbeatActive) return;
    heartbeatActive = true;
    void heartbeat(lease)
      .catch(onHeartbeatError)
      .finally(() => {
        heartbeatActive = false;
      });
  }, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
