import type { NativeRuntimeHandoffState } from "@cantrip/protocol";
import type {
  CodexAppServer,
  PrepareManagedThreadOptions,
} from "./app-server.js";
import type { HandoffRuntime } from "./managed-runtime-handoff.js";
import type { ManagedNativeGateway } from "./managed-native-gateway.js";
import type { TerminalManager } from "../terminal-manager.js";

interface PreparedPublication {
  runtime: CodexAppServer;
  threadId: string;
  subagentDefaults: PrepareManagedThreadOptions["subagentDefaults"];
  executionProfile: PrepareManagedThreadOptions["executionProfile"];
  codexHome: string;
  activate(): void;
  gateway(upstreamUrl: string): Promise<ManagedNativeGateway>;
}

/** Publish only the acknowledged runtime. Failed attachment retains every old
 * runtime awaiting retirement, even when preparation already selected the new one.
 * Runtime processes can serve other chats; retirement closes this chat's gateway only. */
export class ManagedRuntimeHandoffPublication {
  private readonly obsolete = new Map<string, Set<CodexAppServer>>();

  constructor(
    private readonly dependencies: {
      current(chatId: string): CodexAppServer | undefined;
      prepare(
        state: NativeRuntimeHandoffState,
        staged: HandoffRuntime,
      ): Promise<PreparedPublication>;
      terminals: Pick<TerminalManager, "retargetManagedCodex">;
      retire(
        state: NativeRuntimeHandoffState,
        runtime: CodexAppServer,
      ): Promise<void>;
    },
  ) {}

  async publish(
    state: NativeRuntimeHandoffState,
    staged: HandoffRuntime,
    side: "source" | "destination",
  ): Promise<void> {
    const obsolete =
      this.obsolete.get(state.chatId) ?? new Set<CodexAppServer>();
    this.obsolete.set(state.chatId, obsolete);
    const previous = this.dependencies.current(state.chatId);
    if (previous) obsolete.add(previous);
    const prepared = await this.dependencies.prepare(state, staged);
    if (
      prepared.runtime !== staged.runtime ||
      prepared.threadId !== state.source.threadId ||
      prepared.runtime.transportGeneration !==
        (side === "destination"
          ? state.prepared?.runtimeGeneration
          : (state.binding ?? state.source).runtimeGeneration)
    )
      throw new Error("Canonical handoff prepared another runtime or thread.");
    const { model, provider } = staged.configuration;
    const upstreamUrl = await prepared.runtime.remoteEndpoint(model, provider, {
      subagentDefaults: prepared.subagentDefaults,
      executionProfile: prepared.executionProfile,
    });
    const gateway = await prepared.gateway(upstreamUrl);
    await this.dependencies.terminals.retargetManagedCodex(state.chatId, {
      threadId: prepared.threadId,
      remoteUrl: gateway.url,
      model,
      provider,
      codexHome: prepared.codexHome,
    });
    prepared.activate();
    obsolete.delete(prepared.runtime);
    for (const runtime of obsolete) {
      await this.dependencies.retire(state, runtime);
      obsolete.delete(runtime);
    }
    this.obsolete.delete(state.chatId);
  }
}
