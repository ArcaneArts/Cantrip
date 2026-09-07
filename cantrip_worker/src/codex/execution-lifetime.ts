import type { AgentScope } from "@cantrip/protocol";

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
  /** Actual runtime ancestry; absent only for legacy internal test adapters. */
  agentScope?: AgentScope | null;
  signal: AbortSignal;
}

/** CLI roots are authorized by worker preparation, but only native start events
 * create a live turn. MCP arguments and transcript reads cannot create one. */
export class CodexConsoleExecutions {
  private roots = new Map<
    string,
    { chatId: string; lifetime: CodexExecutionLifetime }
  >();
  prepare(chatId: string, threadId: string): void {
    const current = this.roots.get(threadId);
    if (current?.chatId === chatId) return;
    current?.lifetime.abort();
    this.roots.set(threadId, {
      chatId,
      lifetime: new CodexExecutionLifetime(),
    });
  }
  observe(threadId: string, turnId: string): void {
    this.roots.get(threadId)?.lifetime.observe(turnId);
  }
  abort(threadId: string, turnId?: string): void {
    this.roots.get(threadId)?.lifetime.abort(turnId);
  }
  clear(): void {
    for (const root of this.roots.values()) root.lifetime.abort();
    this.roots.clear();
  }
  active(
    chatId: string | null,
    threadId: string,
  ): CodexComputerUseExecution | null {
    const root = this.roots.get(threadId);
    const turnId = root?.lifetime.turnId;
    if (!root || !turnId || (chatId !== null && root.chatId !== chatId))
      return null;
    return this.resolve({ chatId: root.chatId, threadId, turnId });
  }
  resolve(input: {
    chatId: string;
    threadId: string;
    turnId: string;
  }): CodexComputerUseExecution | null {
    const root = this.roots.get(input.threadId);
    const signal = root?.lifetime.signal(input.turnId);
    if (root?.chatId !== input.chatId || !signal) return null;
    return {
      ...input,
      rootThreadId: input.threadId,
      rootTurnId: input.turnId,
      parentThreadId: null,
      agentScope: null,
      signal,
    };
  }
}
