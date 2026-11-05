import type {
  ManagedExecutionAttempt,
  ManagedExecutionGateHandler,
} from "./runtime-types.js";

type AttemptIdentity = Pick<
  ManagedExecutionAttempt,
  "runnerGeneration" | "attemptId" | "threadId" | "turnId"
>;

interface GateEntry {
  handler: ManagedExecutionGateHandler;
  controller: AbortController;
  transportGeneration: string | null;
  observedAttempts: Set<string>;
  pending: Set<string>;
  retired: boolean;
}

interface AttemptOwner extends AttemptIdentity {
  key: string;
  turnKey: string;
  entry: GateEntry;
  controller: AbortController;
}

/** Retain old callbacks only for attempts whose actual native start/decline is
 * still outstanding. Retirement is metadata cleanup, never ticket settlement. */
export class ManagedExecutionGates {
  private readonly entries = new Map<string, GateEntry>();
  private readonly attempts = new Map<string, AttemptOwner>();
  private readonly turns = new Map<string, AttemptOwner>();

  get(generation: string): GateEntry | undefined {
    const entry = this.entries.get(generation);
    return entry?.retired ? undefined : entry;
  }

  set(
    generation: string,
    handler: ManagedExecutionGateHandler | null,
    transportGeneration: string | null,
  ): AbortSignal | null {
    const previous = this.entries.get(generation);
    if (previous) {
      previous.retired = true;
      previous.controller.abort();
      this.prune(generation, previous);
    }
    if (!handler) return null;
    const entry: GateEntry = {
      handler,
      controller: new AbortController(),
      transportGeneration,
      // Retrying an uncertain bind of the same generation must not redeliver
      // attempts already observed by its preceding registration.
      observedAttempts: previous?.observedAttempts ?? new Set(),
      pending: new Set(),
      retired: false,
    };
    this.entries.set(generation, entry);
    return entry.controller.signal;
  }

  begin(entry: GateEntry, identity: AttemptIdentity): AttemptOwner | undefined {
    const key = JSON.stringify([identity.runnerGeneration, identity.attemptId]);
    if (
      entry.retired ||
      entry.observedAttempts.has(identity.attemptId) ||
      this.attempts.has(key)
    )
      return;
    entry.observedAttempts.add(identity.attemptId);
    if (entry.observedAttempts.size > 1000)
      entry.observedAttempts.delete(
        entry.observedAttempts.values().next().value!,
      );
    const turnKey = JSON.stringify([identity.threadId, identity.turnId]);
    const owner = {
      runnerGeneration: identity.runnerGeneration,
      attemptId: identity.attemptId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      key,
      turnKey,
      entry,
      controller: new AbortController(),
    };
    entry.pending.add(key);
    this.attempts.set(key, owner);
    this.turns.set(turnKey, owner);
    return owner;
  }

  pending(identity: AttemptIdentity): AttemptOwner | undefined {
    const owner = this.attempts.get(
      JSON.stringify([identity.runnerGeneration, identity.attemptId]),
    );
    return owner?.threadId === identity.threadId &&
      owner.turnId === identity.turnId
      ? owner
      : undefined;
  }

  consumed(threadId: string, turnId: string): void {
    const owner = this.turns.get(JSON.stringify([threadId, turnId]));
    if (owner) this.settled(owner);
  }

  declined(owner: AttemptOwner): void {
    if (this.attempts.get(owner.key) !== owner) return;
    // Native positively declined this exact attempt. This also cancels a
    // worker admission still waiting before it could send operationGeneration
    // to native. Merely retiring a runner cannot establish that no turn began.
    owner.controller.abort(new Error("Native declined the managed attempt."));
    this.settled(owner);
  }

  settled(owner: AttemptOwner): void {
    if (this.attempts.get(owner.key) !== owner) return;
    this.attempts.delete(owner.key);
    if (this.turns.get(owner.turnKey) === owner)
      this.turns.delete(owner.turnKey);
    owner.entry.pending.delete(owner.key);
    this.prune(owner.runnerGeneration, owner.entry);
  }

  /** Only an acknowledged native bind can retire the previous generation.
   * A deadline, local map replacement, or missing notification proves nothing
   * about an outstanding native attempt; its exact callback remains retained. */
  retire(generation: string, transportGeneration: string): void {
    const entry = this.entries.get(generation);
    if (
      !entry ||
      (entry.transportGeneration &&
        entry.transportGeneration !== transportGeneration)
    )
      return;
    entry.retired = true;
    this.prune(generation, entry);
  }

  clear(): void {
    const entries = new Set(this.entries.values());
    for (const owner of this.attempts.values()) entries.add(owner.entry);
    for (const entry of entries) entry.controller.abort();
    this.entries.clear();
    this.attempts.clear();
    this.turns.clear();
  }

  private prune(generation: string, entry: GateEntry): void {
    if (
      entry.retired &&
      entry.pending.size === 0 &&
      this.entries.get(generation) === entry
    )
      this.entries.delete(generation);
  }
}
