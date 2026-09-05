/** A runtime-observed turn owns its cancellation signal. Repeated notifications
 * for the same terminal turn must never recreate computer-use authority. */
export class CodexExecutionLifetime {
  private turn: { id: string; controller: AbortController } | null = null;

  get turnId(): string | null {
    return this.turn?.id ?? null;
  }

  /** Called only for an actual native turn start, never telemetry. */
  observe(turnId: string): boolean {
    if (this.turn?.id === turnId) return false;
    this.abort();
    this.turn = { id: turnId, controller: new AbortController() };
    return true;
  }

  signal(turnId: string): AbortSignal | null {
    return this.turn?.id === turnId && !this.turn.controller.signal.aborted
      ? this.turn.controller.signal
      : null;
  }

  abort(turnId?: string): boolean {
    if (turnId !== undefined) {
      if (!this.turn) {
        // A terminal event can beat the start response. Remember that one
        // terminal identity so its delayed response cannot revive authority.
        this.turn = { id: turnId, controller: new AbortController() };
      } else if (this.turn.id !== turnId) return false;
    }
    this.turn?.controller.abort();
    return true;
  }
}

/** Only identities observed by this runtime, not account or server claims. */
export interface CodexComputerUseExecution {
  chatId: string;
  threadId: string;
  turnId: string;
  rootThreadId: string;
  rootTurnId: string;
  parentThreadId: string | null;
  signal: AbortSignal;
}
