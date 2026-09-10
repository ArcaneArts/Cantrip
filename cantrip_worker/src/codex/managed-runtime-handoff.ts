import type {
  NativeRuntimeHandoffPrepared,
  NativeRuntimeHandoffState,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import type {
  CodexAppServer,
  PrepareManagedThreadOptions,
} from "./app-server.js";
import type { NativeRuntimeHandoffClient } from "../native-runtime-handoff-client.js";
import { ManagedRuntimeHandoffJournal } from "./managed-runtime-handoff-journal.js";
import type {
  ManagedRuntimeNamespaces,
  ManagedRuntimeNamespaceScope,
} from "./managed-runtime-namespaces.js";

type Preparation = Omit<
  PrepareManagedThreadOptions,
  "threadId" | "intent" | "replacementSettings" | "onThreadIdentified"
>;
export interface HandoffRuntime {
  runtime: Pick<
    CodexAppServer,
    | "prepareManagedThread"
    | "prepareImportedManagedThread"
    | "exportManagedHistory"
    | "readNativeHistory"
    | "resetManagedModelContext"
    | "readNativeThreadSettings"
    | "getManagedModelAttribution"
    | "transportGeneration"
  >;
  home: string;
  configuration: Preparation;
}
export interface ManagedRuntimeHandoffDependencies {
  client: Pick<NativeRuntimeHandoffClient, "request">;
  journal: ManagedRuntimeHandoffJournal;
  namespaces: ManagedRuntimeNamespaces;
  scope: ManagedRuntimeNamespaceScope;
  /** Resolve fresh, exact server-authorized account and full MCP configuration.
   * Destination creation is isolated: no canonical association, observer or CLI
   * publication is allowed here. All prepared runtimes retain the execution gate. */
  resolve(
    state: NativeRuntimeHandoffState,
    side: "source" | "destination",
  ): Promise<HandoffRuntime>;
  /** Encrypt/authenticate the actual native settings read, with exact route attribution. */
  protectSettings(
    state: NativeRuntimeHandoffState,
    side: "source" | "destination",
    runtime: HandoffRuntime,
    settings: Awaited<ReturnType<CodexAppServer["readNativeThreadSettings"]>>,
  ): Promise<ProtectedNativeSettingsSnapshot>;
  /** Adopt the committed association/settings binding, publish the new gateway,
   * retarget any existing CLI, then retire the old gateway. Must be retryable. */
  publish(
    state: NativeRuntimeHandoffState,
    runtime: HandoffRuntime,
  ): Promise<void>;
  completed?(state: NativeRuntimeHandoffState): void;
  restoreSource?(
    state: NativeRuntimeHandoffState,
    runtime: HandoffRuntime,
  ): Promise<void>;
  cancelled?(state: NativeRuntimeHandoffState): void;
}

/** Executes one reserved handoff, with the server phase as the commit authority.
 * It never invents a new transfer ID after an uncertain native/HTTP response. */
export class ManagedRuntimeHandoffCoordinator {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly active = new Map<
    string,
    { operationId: string; controller: AbortController }
  >();
  constructor(
    private readonly dependencies: ManagedRuntimeHandoffDependencies,
  ) {}

  run(
    chatId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<NativeRuntimeHandoffState> {
    const result = (this.operations.get(chatId) ?? Promise.resolve()).then(
      async () => {
        const attempt = { operationId, controller: new AbortController() };
        this.active.set(chatId, attempt);
        try {
          return await this.execute(
            chatId,
            operationId,
            AbortSignal.any([signal, attempt.controller.signal]),
          );
        } finally {
          if (this.active.get(chatId) === attempt) this.active.delete(chatId);
        }
      },
    );
    const settled = result.then(
      () => {},
      () => {},
    );
    this.operations.set(chatId, settled);
    void settled.then(() => {
      if (this.operations.get(chatId) === settled)
        this.operations.delete(chatId);
    });
    return result;
  }

  /** Cancellation is a durable server decision before it interrupts local staging.
   * A commit that won the server transaction can never be rolled back here. */
  async cancel(chatId: string, operationId: string, signal: AbortSignal) {
    const state = await this.dependencies.client.request(
      { chatId, operationId, action: "read" },
      signal,
    );
    if (!state.cancelRequested && state.phase !== "cancelled")
      throw new Error("Handoff cancellation was not reserved by the server.");
    const active = this.active.get(chatId);
    if (active?.operationId === operationId)
      active.controller.abort(new Error("Handoff cancellation requested."));
    return this.run(chatId, operationId, signal);
  }

  private async restore(state: NativeRuntimeHandoffState, signal: AbortSignal) {
    const d = this.dependencies;
    if (state.phase !== "preparing" && state.phase !== "prepared")
      throw new Error("A committed handoff cannot restore the source.");
    const source = await d.resolve(state, "source");
    await source.runtime.prepareManagedThread({
      ...source.configuration,
      threadId: state.source.threadId,
      intent: "preserve",
      signal,
    });
    const observed = await this.snapshot(state, "source", source, signal);
    const binding = state.binding ?? state.source;
    if (
      binding.runtimeGeneration !== observed.runtimeGeneration ||
      binding.nativeEpoch !== observed.snapshot.context.settingsVersion.epoch
    )
      state = await d.client.request(
        {
          chatId: state.chatId,
          operationId: state.operationId,
          action: "recover",
          side: "source",
          expectedBindingId: binding.bindingId,
          recovered: observed,
        },
        signal,
      );
    if (!d.restoreSource)
      throw new Error("Source publication is unavailable for this handoff.");
    await d.restoreSource(state, source);
    signal.throwIfAborted();
    const cancelled = await d.client.request(
      {
        chatId: state.chatId,
        operationId: state.operationId,
        action: "finish",
        outcome: "cancelled",
      },
      signal,
    );
    d.cancelled?.(cancelled);
    return cancelled;
  }

  private async snapshot(
    state: NativeRuntimeHandoffState,
    side: "source" | "destination",
    prepared: HandoffRuntime,
    signal: AbortSignal,
  ): Promise<NativeRuntimeHandoffPrepared> {
    signal.throwIfAborted();
    const generation = prepared.runtime.transportGeneration;
    const settings = await prepared.runtime.readNativeThreadSettings(
      state.source.threadId,
    );
    const snapshot = await this.dependencies.protectSettings(
      state,
      side,
      prepared,
      settings,
    );
    signal.throwIfAborted();
    if (
      !generation ||
      prepared.runtime.transportGeneration !== generation ||
      snapshot.context.runtimeGeneration !== generation
    )
      throw new Error(
        "Native runtime changed during handoff settings capture.",
      );
    return {
      threadId: state.source.threadId,
      runtimeGeneration: generation,
      snapshot,
      reasoningEffort: settings.confirmed!.settings.effort ?? null,
    };
  }

  private async execute(
    chatId: string,
    operationId: string,
    signal: AbortSignal,
  ) {
    const d = this.dependencies;
    const scope = { chatId, operationId };
    let state = await d.client.request({ ...scope, action: "read" }, signal);
    if (state.phase === "completed") {
      d.completed?.(state);
      return state;
    }
    if (state.phase === "cancelled") {
      d.cancelled?.(state);
      return state;
    }
    try {
      if (state.cancelRequested) return await this.restore(state, signal);
      let source: HandoffRuntime | undefined;
      if (state.phase !== "committed") {
        source = await d.resolve(state, "source");
        await source.runtime.prepareManagedThread({
          ...source.configuration,
          threadId: state.source.threadId,
          intent: "preserve",
          signal,
        });
        const observed = await this.snapshot(state, "source", source, signal);
        const binding = state.binding ?? state.source;
        if (
          binding.runtimeGeneration !== observed.runtimeGeneration ||
          binding.nativeEpoch !==
            observed.snapshot.context.settingsVersion.epoch
        ) {
          state = await d.client.request(
            {
              ...scope,
              action: "recover",
              side: "source",
              expectedBindingId: binding.bindingId,
              recovered: observed,
            },
            signal,
          );
        }
      }
      const plan = await d.journal.prepare(state, async () => {
        if (!source)
          throw new Error("Missing source export plan after commit.");
        return {
          sourceHome: source.home,
          expectedLastTurnId:
            (
              await source.runtime.readNativeHistory(state.source.threadId)
            ).thread.turns.at(-1)?.id ?? null,
          previousOperationId:
            d.namespaces.current(d.scope, state.source.threadId)?.operationId ??
            null,
        };
      });
      const transfer = state.prepared
        ? null
        : await d.journal.export(plan, async (input) => {
            if (!source)
              throw new Error("Missing source export before preparation.");
            return source.runtime.exportManagedHistory(input, signal);
          });
      const target = await d.resolve(state, "destination");
      if (
        target.home !==
        d.namespaces.destination(d.scope, state.source.threadId, operationId)
      )
        throw new Error("Handoff destination uses another storage namespace.");
      if (state.prepared) {
        // The server already acknowledged import and destination preparation.
        // Resume that conversation; replaying the original import could reject
        // a relocated rollout or overwrite state retained after publication.
        const resumed = await target.runtime.prepareManagedThread({
          ...target.configuration,
          threadId: state.source.threadId,
          intent: "preserve",
          signal,
        });
        if (resumed.threadId !== state.source.threadId)
          throw new Error("Handoff recovery resumed another conversation.");
      } else {
        await target.runtime.prepareImportedManagedThread({
          ...target.configuration,
          transfer: transfer!,
          signal,
        });
      }
      if (state.phase !== "committed") {
        // Model context changes without creating another conversation. The
        // native operation checks the durable last-turn boundary under its lock.
        await target.runtime.resetManagedModelContext(
          state.source.threadId,
          plan.expectedLastTurnId,
          signal,
        );
        state = await d.client.request(
          {
            ...scope,
            action: "prepared",
            expectedPreparedRuntimeGeneration:
              state.prepared?.runtimeGeneration ?? null,
            expectedPreparedNativeEpoch:
              state.prepared?.snapshot.context.settingsVersion.epoch ?? null,
            prepared: await this.snapshot(state, "destination", target, signal),
          },
          signal,
        );
        state = await d.client.request({ ...scope, action: "commit" }, signal);
      } else {
        const observed = await this.snapshot(
          state,
          "destination",
          target,
          signal,
        );
        if (
          observed.runtimeGeneration !== state.prepared!.runtimeGeneration ||
          observed.snapshot.context.settingsVersion.epoch !==
            state.prepared!.snapshot.context.settingsVersion.epoch
        ) {
          if (!state.binding)
            throw new Error(
              "Committed handoff requires its current canonical binding.",
            );
          state = await d.client.request(
            {
              ...scope,
              action: "recover",
              side: "destination",
              expectedBindingId: state.binding.bindingId,
              recovered: observed,
            },
            signal,
          );
        }
      }
      signal.throwIfAborted();
      await d.namespaces.select({
        scope: d.scope,
        handoff: state,
        provider: {
          id: target.configuration.provider.id,
          kind: target.configuration.provider.kind,
          accountId: target.configuration.provider.accountId ?? null,
        },
        previousOperationId: plan.previousOperationId,
      });
      await d.publish(state, target);
      signal.throwIfAborted();
      const completed = await d.client.request(
        { ...scope, action: "finish", outcome: "completed" },
        signal,
      );
      d.completed?.(completed);
      return completed;
    } catch (error) {
      // A failure records diagnostic state; it does not revoke the reservation,
      // change its phase, re-export, or silently route back to the source.
      await d.client
        .request({
          ...scope,
          action: "failure",
          errorCode: "handoff-worker-operation-failed",
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
