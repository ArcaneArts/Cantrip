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
  await heartbeat(lease);
  let pendingHeartbeat = Promise.resolve();
  const timer = setInterval(() => {
    pendingHeartbeat = pendingHeartbeat
      .then(() => heartbeat(lease))
      .then(() => undefined)
      .catch(onHeartbeatError);
  }, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    await pendingHeartbeat;
  }
}
