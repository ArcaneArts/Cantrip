export interface ChatTurnOutcomeLane {
  scratchRootId: string | null;
  state: string;
  workerId: string;
  worktreeId: string | null;
}

export interface ChatTurnOutcomeMessage {
  executionLaneId: string | null;
  id: string;
  role: string;
}

export class ChatTurnOutcomeRecoveryScheduler {
  readonly #delayMs: number;
  readonly #recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #settledTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #settledKeys = new Set<string>();
  readonly #settlementRetentionMs: number;

  constructor(delayMs = 1_000, settlementRetentionMs = 60_000) {
    this.#delayMs = delayMs;
    this.#settlementRetentionMs = settlementRetentionMs;
  }

  schedule(key: string, recover: () => void): boolean {
    if (this.#settledKeys.has(key)) return false;
    const existing = this.#recoveryTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#recoveryTimers.delete(key);
      recover();
    }, this.#delayMs);
    timer.unref();
    this.#recoveryTimers.set(key, timer);
    return true;
  }

  settle(key: string): void {
    const recoveryTimer = this.#recoveryTimers.get(key);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    this.#recoveryTimers.delete(key);
    const settledTimer = this.#settledTimers.get(key);
    if (settledTimer) clearTimeout(settledTimer);
    this.#settledKeys.add(key);
    const timer = setTimeout(() => {
      this.#settledKeys.delete(key);
      this.#settledTimers.delete(key);
    }, this.#settlementRetentionMs);
    timer.unref();
    this.#settledTimers.set(key, timer);
  }

  clear(): void {
    for (const timer of this.#recoveryTimers.values()) clearTimeout(timer);
    for (const timer of this.#settledTimers.values()) clearTimeout(timer);
    this.#recoveryTimers.clear();
    this.#settledTimers.clear();
    this.#settledKeys.clear();
  }
}

export function chatTurnOutcomeRecoveryKey(
  workerId: string,
  chatId: string,
  clientMessageId: string,
): string {
  return `${workerId}:${chatId}:${clientMessageId}`;
}

export function shouldRecoverChatTurnOutcome(
  lane: ChatTurnOutcomeLane | null,
  workerId: string,
  worktreeId: string | null,
  scratchRootId: string | null,
): boolean {
  return (
    lane?.state === "active" &&
    lane.workerId === workerId &&
    lane.worktreeId === worktreeId &&
    lane.scratchRootId === scratchRootId
  );
}

export function outcomeBelongsToLatestLaneTurn(
  messages: readonly ChatTurnOutcomeMessage[],
  executionLaneId: string,
  clientMessageId: string,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      message.executionLaneId === executionLaneId
    ) {
      return message.id === clientMessageId;
    }
  }
  return true;
}
