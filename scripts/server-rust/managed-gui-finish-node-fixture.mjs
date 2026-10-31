import { EventEmitter } from "node:events";
import { finishManagedGui } from "../../cantrip_server/src/app/runtime/finish-managed-gui.ts";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.ts";
import { LimitedWorkerCommandBus } from "../../cantrip_server/src/workers/limited-command-bus.ts";
export async function managedGuiFinishFixture(repository, input) {
  const trace = [],
    bridge = new WorkerBridge(15000, { event() {}, rateLimited() {} });
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    send(data) {
      const frame = JSON.parse(String(data));
      queueMicrotask(async () => {
        const c = frame.command;
        const committed = await repository.nativeCommands.getLogicalCompletion(
          input.owner,
          input.worker,
          c.chatId,
          c.rootOperationId,
          c.rootOperationGeneration,
        );
        trace.push({
          kind: "request",
          workerId: input.worker,
          command: c,
          committed: committed !== null,
        });
        this.emit(
          "message",
          JSON.stringify({
            kind: "response",
            requestId: frame.requestId,
            ok: !input.responseError,
            ...(input.responseError
              ? {
                  error: {
                    message: "Managed GUI acknowledgment failed",
                    code: "gui-finish-fixture",
                  },
                }
              : { result: null }),
          }),
          false,
        );
      });
    }
  }
  if (!bridge.attach(input.worker, new Socket(), input.owner))
    throw new Error("Managed GUI peer attach");
  const commands = new LimitedWorkerCommandBus(bridge, {
    accountConcurrency: 32,
    accountRatePerMinute: 10000,
    workerConcurrency: 32,
    workerRatePerMinute: 10000,
    resolveOwnerId: (w) => repository.getWorkerOwnerId(w),
  });
  try {
    const finished = await finishManagedGui({
      repository,
      bridge: commands,
      ownerId: input.owner,
      workerId: input.worker,
      receipt: input.receipt,
      status: input.status,
      onAcknowledgementError: () => trace.push({ kind: "ack-error" }),
    });
    return { finished, trace };
  } finally {
    await bridge.close();
  }
}
