import { AsyncLocalStorage } from "node:async_hooks";
import { ClaimedInferenceSource } from "./inference-source.js";
import type {
  InferenceCommandTiming,
  InferenceTicketState,
  WorkerEvent,
  WorkerCommand,
} from "@cantrip/protocol";

type Phase = "waiting" | "preparing" | "running";
const commands = new AsyncLocalStorage<InferenceCommand>();
const activeCommands = new Set<InferenceCommand>();

export interface InferenceResourceOwner {
  serverId: string;
  ownerId: string;
  workerId: string;
  chatId: string | null;
  projectId: string | null;
}

export type InferenceResourceTarget = Extract<
  WorkerCommand,
  { type: "inference.revoke" }
>["target"];

/** Resource IDs come from the authenticated command, before asynchronous routing. */
export function inferenceCommandResource(
  command: WorkerCommand,
): Pick<InferenceResourceOwner, "chatId" | "projectId"> {
  const session = "session" in command ? command.session : undefined;
  return {
    chatId:
      "chatId" in command && typeof command.chatId === "string"
        ? command.chatId
        : session && typeof session.chatId === "string"
          ? session.chatId
          : null,
    projectId:
      "projectId" in command && typeof command.projectId === "string"
        ? command.projectId
        : session &&
            "projectId" in session &&
            typeof session.projectId === "string"
          ? session.projectId
          : null,
  };
}

/** One exclusive clock for a command, or for one provider within that command. */
class InferencePhaseClock {
  private readonly operations = new Map<symbol, InferenceTicketState>();
  state: Phase = "preparing";
  private timingPhase: keyof Omit<InferenceCommandTiming, "complete"> =
    "preparationMs";
  private changedAt = performance.now();
  private readonly durations = {
    queueWaitMs: 0,
    preparationMs: 0,
    executionMs: 0,
    suspendedMs: 0,
  };

  constructor(private readonly activeOnly = false) {}

  clear(): void {
    this.operations.clear();
  }

  observe(identity: symbol, state: InferenceTicketState): boolean {
    this.account();
    if (state === "released") this.operations.delete(identity);
    else this.operations.set(identity, state);
    const states = [...this.operations.values()];
    const phase: Phase = states.some(
      (value) => value === "running" || value === "cancelling",
    )
      ? "running"
      : states.length > 0 &&
          states.every((value) => value === "waiting" || value === "suspended")
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
    const changed = phase !== this.state || timingPhase !== this.timingPhase;
    this.state = phase;
    this.timingPhase = timingPhase;
    return changed;
  }

  private account(): void {
    const now = performance.now();
    if (!this.activeOnly || this.operations.size > 0)
      this.durations[this.timingPhase] += Math.max(0, now - this.changedAt);
    this.changedAt = now;
  }

  snapshot(final: boolean): InferenceCommandTiming {
    this.account();
    return {
      queueWaitMs: Math.floor(this.durations.queueWaitMs),
      preparationMs: Math.floor(this.durations.preparationMs),
      executionMs: Math.floor(this.durations.executionMs),
      suspendedMs: Math.floor(this.durations.suspendedMs),
      // A closed command may still have an execution being reconciled.
      complete: final && this.operations.size === 0,
    };
  }
}

/** Correlates timing with its existing worker request, without owning admission. */
class InferenceCommand {
  private readonly clock = new InferencePhaseClock();
  private readonly providers = new Map<string, InferencePhaseClock>();
  private sequence = 0;
  private closed = false;
  private admitted = false;
  private observed = false;
  private inferenceAttempt = 0n;
  private readonly sources = new Set<ClaimedInferenceSource>();
  private readonly operations = new Set<string>();
  private readonly cancellation = new AbortController();
  readonly signal: AbortSignal;

  constructor(
    private readonly emit: (event: WorkerEvent) => void,
    private readonly admissionAck: boolean,
    private readonly operationIdentity?: string,
    operationSignal?: AbortSignal,
    readonly resource?: InferenceResourceOwner,
  ) {
    this.signal = operationSignal
      ? AbortSignal.any([operationSignal, this.cancellation.signal])
      : this.cancellation.signal;
  }

  track(operationId: string): void {
    if (this.closed) return;
    this.signal.throwIfAborted();
    this.operations.add(operationId);
  }

  revoke(): string[] {
    this.cancellation.abort(new Error("The owning resource was removed."));
    for (const source of this.sources) source.close();
    return [...this.operations];
  }

  claimSource(signal?: AbortSignal): ClaimedInferenceSource | undefined {
    if (!this.operationIdentity) return undefined;
    if (this.closed)
      throw new Error("The owning worker inference command has ended.");
    this.signal.throwIfAborted();
    const source = new ClaimedInferenceSource(
      `worker-command:${this.operationIdentity}:inference:${++this.inferenceAttempt}`,
      signal ? AbortSignal.any([this.signal, signal]) : this.signal,
    );
    this.sources.add(source);
    void source.source.released.then(() => this.sources.delete(source));
    return source;
  }

  /** Captured by the operation at creation, before any asynchronous journal IO. */
  observeAdmission(): (() => void) | undefined {
    if (this.closed || !this.admissionAck) return undefined;
    return () => {
      if (this.closed || this.admitted) return;
      this.admitted = true;
      this.report(false, true);
    };
  }

  observe(
    providerId?: string,
  ): ((state: InferenceTicketState) => void) | undefined {
    if (this.closed) return undefined;
    this.observed = true;
    const identity = Symbol();
    let providerClock = providerId ? this.providers.get(providerId) : undefined;
    if (providerId && !providerClock) {
      providerClock = new InferencePhaseClock(true);
      this.providers.set(providerId, providerClock);
    }
    return (state) => {
      if (this.closed) return;
      const changed = this.clock.observe(identity, state);
      const providerChanged = providerClock?.observe(identity, state);
      if (changed || providerChanged) this.report();
    };
  }

  private report(final = false, admitted = false): void {
    // Reporting never owns or mutates admission, including when delivery fails.
    try {
      this.emit({
        type: "inference.command-state",
        sequence: this.sequence++,
        state: this.clock.state,
        timing: this.clock.snapshot(final),
        providerTimings: [...this.providers].map(([providerId, clock]) => ({
          providerId,
          timing: clock.snapshot(final),
        })),
        ...(admitted ? { admitted: true } : {}),
      });
    } catch {}
  }

  close(): void {
    if (this.closed) return;
    if (this.observed) this.report(true);
    this.closed = true;
    for (const source of this.sources) source.close();
    this.sources.clear();
    this.operations.clear();
    this.clock.clear();
    for (const clock of this.providers.values()) clock.clear();
    this.providers.clear();
  }
}

export function observeInferenceCommand(
  providerId?: string,
): ((state: InferenceTicketState) => void) | undefined {
  return commands.getStore()?.observe(providerId);
}

export function observeInferenceCommandAdmission(): (() => void) | undefined {
  return commands.getStore()?.observeAdmission();
}

/** Called for an actual standalone helper attempt within a transport-issued
 * command. No owner is minted from an external operation UUID or a cache miss. */
export function claimInferenceCommandSource(signal?: AbortSignal) {
  return commands.getStore()?.claimSource(signal);
}

export function inferenceCommandSignal(): AbortSignal | undefined {
  return commands.getStore()?.signal;
}

/** Records actual admission calls, including legacy helper identities. It does
 * not grant execution authority or preserve a history of completed UUIDs. */
export function trackInferenceCommandOperation(operationId: string): void {
  commands.getStore()?.track(operationId);
}

export function revokeInferenceCommands(
  scope: Pick<InferenceResourceOwner, "serverId" | "ownerId" | "workerId">,
  target: InferenceResourceTarget,
): Set<string> {
  const operations = new Set<string>();
  const chatIds = new Set(
    target.kind === "chat" ? [target.chatId] : target.chatIds,
  );
  for (const command of activeCommands) {
    const owner = command.resource;
    if (
      !owner ||
      owner.serverId !== scope.serverId ||
      owner.ownerId !== scope.ownerId ||
      owner.workerId !== scope.workerId
    )
      continue;
    if (
      !(owner.chatId && chatIds.has(owner.chatId)) &&
      !(target.kind === "project" && owner.projectId === target.projectId)
    )
      continue;
    for (const operationId of command.revoke()) operations.add(operationId);
  }
  return operations;
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
  operationIdentity?: string,
  operationSignal?: AbortSignal,
  resource?: InferenceResourceOwner,
): Promise<T> {
  const command = new InferenceCommand(
    emit,
    admissionAck,
    operationIdentity,
    operationSignal,
    resource,
  );
  activeCommands.add(command);
  try {
    return await commands.run(command, action);
  } finally {
    activeCommands.delete(command);
    command.close();
  }
}
