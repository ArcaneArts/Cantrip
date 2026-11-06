import {
  taskInferenceInputReceiptSchema,
  type TaskInferenceInputReceipt,
  type InferenceNativeExecution,
  type NativeSuspensionActiveTurn,
  type NativeSuspensionEvidence,
  type TaskPauseScope,
} from "@cantrip/protocol";
import { isDeepStrictEqual } from "node:util";

interface Execution {
  scope: { serverId: string; ownerId: string; workerId: string };
  receipt: TaskInferenceInputReceipt;
  controller: AbortController;
  finish(): void;
  native?: { execution: InferenceNativeExecution; runtimeGeneration: string };
  checkpoint?: (
    active: NativeSuspensionActiveTurn,
  ) => Promise<NativeSuspensionEvidence>;
  onNativeBound?: (execution: InferenceNativeExecution) => void;
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
    checkpoint?: Execution["checkpoint"],
    onNativeBound?: Execution["onNativeBound"],
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
      checkpoint,
      onNativeBound,
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

  /** Installed only after the keeper and canonical input binding both ACK. */
  bind(
    receipt: TaskInferenceInputReceipt,
    scope: Execution["scope"],
    execution: InferenceNativeExecution,
    runtimeGeneration: string,
  ) {
    const entry = this.active.get(receipt.operationId);
    if (!entry || !this.matches(entry, receipt, scope))
      throw new Error(
        "The Task native binding no longer has its physical owner.",
      );
    entry.controller.signal.throwIfAborted();
    const native = { execution, runtimeGeneration };
    if (entry.native) {
      if (!isDeepStrictEqual(entry.native, native))
        throw new Error("The Task native binding changed its execution.");
      return;
    }
    entry.native = structuredClone(native);
    entry.onNativeBound?.(execution);
  }

  private matches(
    entry: Execution,
    receipt: TaskInferenceInputReceipt,
    scope: Execution["scope"],
  ) {
    return (
      isDeepStrictEqual(entry.scope, scope) &&
      isDeepStrictEqual(entry.receipt, receipt)
    );
  }

  async pauseState(
    chatId: string,
    scope: Execution["scope"],
    target: TaskPauseScope,
    active: NativeSuspensionActiveTurn,
    paused: boolean,
    workerGeneration: string,
  ) {
    const entries = [...this.active.values()].filter(
      (entry) =>
        entry.receipt.chatId === chatId &&
        this.matches(entry, entry.receipt, scope) &&
        entry.receipt.dispatch.cycleId === target.cycleId &&
        entry.native?.execution.threadId === active.threadId &&
        entry.native.execution.turnId === active.turnId,
    );
    if (entries.length !== 1)
      throw new Error("The Task control has no unique canonical native owner.");
    const entry = entries[0]!;
    const native = entry.native!;
    entry.controller.signal.throwIfAborted();
    if (paused && !entry.checkpoint)
      throw new Error(
        "This Task execution cannot yet commit a durable continuation.",
      );
    const checkpoint = paused ? await entry.checkpoint!(active) : null;
    entry.controller.signal.throwIfAborted();
    if (
      this.active.get(entry.receipt.operationId) !== entry ||
      entry.native !== native
    )
      throw new Error(
        "The Task execution changed while its continuation was committed.",
      );
    return {
      actor: {
        workerGeneration,
        runtimeGeneration: native.runtimeGeneration,
        operationId: entry.receipt.operationId,
        operationGeneration: entry.receipt.operationId,
      },
      checkpoint,
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
