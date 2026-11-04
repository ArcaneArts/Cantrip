import { AsyncLocalStorage } from "node:async_hooks";
import type { InferenceTicketState, WorkerEvent } from "@cantrip/protocol";

type Phase = "waiting" | "preparing" | "running";
const commands = new AsyncLocalStorage<InferenceCommand>();

/** Correlates timing with its existing worker request, without owning admission. */
class InferenceCommand {
  private readonly operations = new Map<symbol, InferenceTicketState>();
  private phase: Phase = "preparing";
  private sequence = 0;
  private closed = false;

  constructor(private readonly emit: (event: WorkerEvent) => void) {}

  observe(): ((state: InferenceTicketState) => void) | undefined {
    if (this.closed) return undefined;
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
      if (phase === this.phase) return;
      this.phase = phase;
      // The worker connection already buffers events for an accepted request.
      // A reporting failure must not mutate a ticket or stop an admitted turn.
      try {
        this.emit({
          type: "inference.command-state",
          sequence: this.sequence++,
          state: phase,
        });
      } catch {}
    };
  }

  close(): void {
    this.closed = true;
    this.operations.clear();
  }
}

export function observeInferenceCommand():
  ((state: InferenceTicketState) => void) | undefined {
  return commands.getStore()?.observe();
}

/** Socket callbacks can inherit the context that created the socket. Native
 * independent operations must not attach to that unrelated old command. */
export function withoutInferenceCommand<T>(action: () => T): T {
  return commands.exit(action);
}

export async function withInferenceCommand<T>(
  emit: (event: WorkerEvent) => void,
  action: () => Promise<T>,
): Promise<T> {
  const command = new InferenceCommand(emit);
  try {
    return await commands.run(command, action);
  } finally {
    command.close();
  }
}
