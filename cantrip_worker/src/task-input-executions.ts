import {
  taskInferenceInputReceiptSchema,
  type TaskInferenceInputReceipt,
} from "@cantrip/protocol";

interface Execution {
  scope: { serverId: string; ownerId: string; workerId: string };
  receipt: TaskInferenceInputReceipt;
  controller: AbortController;
  finish(): void;
}

/** Current physical command owners, not another Task queue or receipt ledger.
 * Register before the claim RPC; mint inference authority only after its ACK. */
export class TaskInputExecutions {
  private readonly active = new Map<string, Execution>();
  constructor(
    private readonly onSettled: (
      scope: Execution["scope"],
      inputOperationId: string,
    ) => void,
  ) {}

  begin(
    input: TaskInferenceInputReceipt,
    scope: Execution["scope"],
    signal?: AbortSignal,
  ) {
    const receipt = taskInferenceInputReceiptSchema.parse(input);
    if (receipt.workerId !== scope.workerId)
      throw new Error("The Task input belongs to another worker.");
    if (this.active.has(receipt.operationId))
      throw new Error(
        "The Task input already has a live physical command owner.",
      );
    const controller = new AbortController();
    const entry: Execution = {
      receipt,
      scope: { ...scope },
      controller,
      finish: () => {
        if (this.active.get(receipt.operationId) !== entry) return;
        this.active.delete(receipt.operationId);
        if (!controller.signal.aborted) return;
        try {
          this.onSettled(entry.scope, receipt.operationId);
        } catch {
          /* Publication cannot retain a physically settled operation. */
        }
      },
    };
    this.active.set(receipt.operationId, entry);
    return {
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      /** Call after runTurn's physical inference settlement, or before it entered. */
      settled: entry.finish,
    };
  }

  async revoke(
    input: TaskInferenceInputReceipt,
    scope: Execution["scope"],
    reconcileOwnership: () => Promise<void>,
  ) {
    const source = taskInferenceInputReceiptSchema.parse(input);
    const current = this.active.get(source.operationId);
    if (current) {
      if (
        current.scope.serverId !== scope.serverId ||
        current.scope.ownerId !== scope.ownerId ||
        current.scope.workerId !== scope.workerId ||
        JSON.stringify(current.receipt) !== JSON.stringify(source)
      )
        throw new Error(
          "The Task input cancellation changed its canonical receipt.",
        );
      current.controller.abort(
        new Error(
          "The Task input's dispatch fence was revoked for provider transfer.",
        ),
      );
      return false;
    } else {
      // The server already revoked the one-time dispatch fence. Registration
      // precedes claim, and removal follows physical settlement. On restart,
      // actual keeper takeover additionally fences every surviving old runtime.
      await reconcileOwnership();
      return true;
    }
  }
}
