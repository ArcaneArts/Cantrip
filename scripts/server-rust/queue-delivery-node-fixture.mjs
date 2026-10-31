import { EventEmitter } from "node:events";
import { createManagedQueueDelivery } from "../../cantrip_server/src/app/runtime/managed-queue-delivery.ts";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.ts";
import { LimitedWorkerCommandBus } from "../../cantrip_server/src/workers/limited-command-bus.ts";

export async function queueDeliveryFixture(repository, input) {
  const trace = [],
    bridge = new WorkerBridge(15000, { event() {}, rateLimited() {} });
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    constructor(workerId) {
      super();
      this.workerId = workerId;
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    send(data) {
      const frame = JSON.parse(String(data));
      trace.push({
        kind: "request",
        workerId: this.workerId,
        command: frame.command,
      });
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({
            kind: "response",
            requestId: frame.requestId,
            ok: !input.responseError,
            ...(input.responseError
              ? {
                  error: {
                    message: "Queue worker failed",
                    code: "queue-fixture-failure",
                  },
                }
              : { result: null }),
          }),
          false,
        ),
      );
    }
  }
  const workers = new Set();
  for (const entry of await repository.managedQueue.pendingNotifications()) {
    if (workers.has(entry.workerId)) continue;
    workers.add(entry.workerId);
    if (
      !bridge.attach(entry.workerId, new Socket(entry.workerId), entry.ownerId)
    )
      throw new Error("Queue peer attach");
  }
  const commands = new LimitedWorkerCommandBus(bridge, {
    accountConcurrency: 32,
    accountRatePerMinute: 10000,
    workerConcurrency: 32,
    workerRatePerMinute: 10000,
    resolveOwnerId: (worker) => repository.getWorkerOwnerId(worker),
  });
  const service = createManagedQueueDelivery({
    repository: repository.managedQueue,
    bridge: commands,
    publish: (ownerId, chatId) =>
      trace.push({ kind: "publish", ownerId, chatId }),
    onError: (error) => trace.push({ kind: "error", message: error.message }),
  });
  try {
    await service.runOnce();
    return trace;
  } finally {
    service.stop();
    await bridge.close();
  }
}
