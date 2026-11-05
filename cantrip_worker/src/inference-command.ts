import { AsyncLocalStorage } from "node:async_hooks";
import type {
  InferenceCommandTiming,
  InferenceTicketState,
  WorkerEvent,
} from "@cantrip/protocol";

type Phase = "waiting" | "preparing" | "running";
const commands = new AsyncLocalStorage<InferenceCommand>();

/** Correlates timing with its existing worker request, without owning admission. */
class InferenceCommand {
  private readonly operations = new Map<symbol, InferenceTicketState>();
  private phase: Phase = "preparing";
  private timingPhase: keyof Omit<InferenceCommandTiming, "complete"> =
    "preparationMs";
  private changedAt = performance.now();
  private readonly durations = {
    queueWaitMs: 0,
    preparationMs: 0,
    executionMs: 0,
    suspendedMs: 0,
  };
  private sequence = 0;
  private closed = false;
  private admitted = false;
  private observed = false;

  constructor(
    private readonly emit: (event: WorkerEvent) => void,
    private readonly admissionAck: boolean,
  ) {}

  /** Captured by the operation at creation, before any asynchronous journal IO. */
  observeAdmission(): (() => void) | undefined {
    if (this.closed || !this.admissionAck) return undefined;
    return () => {
      if (this.closed || this.admitted) return;
      this.admitted = true;
      this.report(false, true);
    };
  }

  observe(): ((state: InferenceTicketState) => void) | undefined {
    if (this.closed) return undefined;
    this.observed = true;
    const identity = Symbol();
    return (state) => {
      if (this.closed) return;
      if (state === "released") this.operations.delete(identity);
      else this.operations.set(identity, state);
      const states = [...this.operations.values()];
      const phase: Phase = states.some(
        (value) => value === "running" || value === "cancelling",
      )
        ? "running"
        : states.length > 0 &&
            states.every(
              (value) => value === "waiting" || value === "suspended",
            )
          ? "waiting"
          : "preparing";
      const timingPhase =
        phase === "running"
          ? "executionMs"
          : phase === "preparing"
            ? "preparationMs"
            : states.every((value) => value === "suspended")
              ? "suspendedMs"
              : "queueWaitMs";
      if (phase === this.phase && timingPhase === this.timingPhase) return;
      this.account();
      this.phase = phase;
      this.timingPhase = timingPhase;
      this.report();
    };
  }

  private account(): void {
    const now = performance.now();
    this.durations[this.timingPhase] += Math.max(0, now - this.changedAt);
    this.changedAt = now;
  }

  private report(complete = false, admitted = false): void {
    this.account();
    const timing: InferenceCommandTiming = {
      queueWaitMs: Math.floor(this.durations.queueWaitMs),
      preparationMs: Math.floor(this.durations.preparationMs),
      executionMs: Math.floor(this.durations.executionMs),
      suspendedMs: Math.floor(this.durations.suspendedMs),
      complete,
    };
    // Reporting never owns or mutates admission, including when delivery fails.
    try {
      this.emit({
        type: "inference.command-state",
        sequence: this.sequence++,
        state: this.phase,
        timing,
        ...(admitted ? { admitted: true } : {}),
      });
    } catch {}
  }

  close(): void {
    if (this.closed) return;
    // A command can fail while native settlement is still being reconciled.
    // Do not advertise that partial observation as a completed turn sample.
    if (this.observed) this.report(this.operations.size === 0);
    this.closed = true;
    this.operations.clear();
  }
}

export function observeInferenceCommand():
  ((state: InferenceTicketState) => void) | undefined {
  return commands.getStore()?.observe();
}

export function observeInferenceCommandAdmission(): (() => void) | undefined {
  return commands.getStore()?.observeAdmission();
}

/** Socket callbacks can inherit the context that created the socket. Native
 * independent operations must not attach to that unrelated old command. */
export function withoutInferenceCommand<T>(action: () => T): T {
  return commands.exit(action);
}

export async function withInferenceCommand<T>(
  emit: (event: WorkerEvent) => void,
  action: () => Promise<T>,
  admissionAck = false,
): Promise<T> {
  const command = new InferenceCommand(emit, admissionAck);
  try {
    return await commands.run(command, action);
  } finally {
    command.close();
  }
}
