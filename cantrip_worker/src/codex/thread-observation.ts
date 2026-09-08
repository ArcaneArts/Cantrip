import type { AgentThreadSync } from "@cantrip/protocol";
import type { CodexRuntime } from "./runtime.js";

export interface ThreadObservationScope {
  serverId: string;
  ownerId: string;
  workerId: string;
  chatId: string;
  threadId: string;
  cwd: string;
  modelRouteId: string | undefined;
  providerId: string;
  providerKind: string;
  providerAccountId: string | null | undefined;
  credentialHomeKey: string | null | undefined;
}

/** Live observation follows the prepared runtime, never a newly selected child route. */
export class ThreadObservationRegistry {
  private readonly bindings = new Map<
    string,
    Pick<CodexRuntime, "observeThread">
  >();

  private key(scope: ThreadObservationScope): string {
    return JSON.stringify([
      scope.serverId,
      scope.ownerId,
      scope.workerId,
      scope.chatId,
      scope.threadId,
      scope.cwd,
      scope.modelRouteId,
      scope.providerId,
      scope.providerKind,
      scope.providerAccountId ?? null,
      scope.credentialHomeKey ?? null,
    ]);
  }

  bind(
    scope: ThreadObservationScope,
    runtime: Pick<CodexRuntime, "observeThread">,
  ): void {
    this.bindings.set(this.key(scope), runtime);
  }

  async sync(
    scope: ThreadObservationScope,
    coldRead: () => Promise<AgentThreadSync>,
  ): Promise<AgentThreadSync> {
    const runtime = this.bindings.get(this.key(scope));
    const observed = await runtime?.observeThread({
      cwd: scope.cwd,
      threadId: scope.threadId,
    });
    // Missing live transport is different from a failed read. Actual read errors
    // propagate; only cold observation uses current authorized root bootstrap.
    return observed ?? coldRead();
  }
}
