import type { NativeRuntimeHandoffState } from "@cantrip/protocol";
import type { CodexAppServer } from "./app-server.js";
import type { ManagedRuntimeHandoffStaging } from "./managed-runtime-handoff-staging.js";

/** Finalization is retryable after the durable phase settles. Releasing a local
 * staging promise alone does not wake native work that was previously deferred. */
export async function completeManagedRuntimeHandoff(options: {
  state: NativeRuntimeHandoffState;
  current: CodexAppServer | undefined;
  staging: ManagedRuntimeHandoffStaging<CodexAppServer>;
  observe(runtime: CodexAppServer): void;
  wake(runtime: CodexAppServer): Promise<void>;
}): Promise<void> {
  const { state, current } = options;
  const generation =
    state.phase === "completed"
      ? state.prepared?.runtimeGeneration
      : state.phase === "cancelled"
        ? (state.binding ?? state.source).runtimeGeneration
        : null;
  if (!generation || !current || current.transportGeneration !== generation)
    return;
  options.staging.release(current, state.source.threadId, state.operationId);
  options.observe(current);
  await options.wake(current);
}
