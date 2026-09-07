import type { CantripMcpBinding } from "@cantrip/protocol";
import type { CuaAgentAuthority } from "@cantrip/protocol/computer-use-agent";
import type { CodexComputerUseExecution } from "../codex/execution-lifetime.js";
import type { CuaMcpExecutor } from "../mcp/cua-contract.js";
import type { CuaAgentCoordinator } from "./agent.js";
import type { CuaAgentApprovalPublisher } from "./agent-approval-events.js";

/** Shares one registration across calls in a real CLI turn. Authorization is
 * still refreshed by the coordinator for every operation, including revocation. */
export function consoleCuaExecutor(options: {
  coordinator: Pick<CuaAgentCoordinator, "register" | "execute">;
  resolve(input: {
    chatId: string;
    threadId: string;
    turnId: string;
  }): CodexComputerUseExecution | null;
  authority(
    binding: CantripMcpBinding,
    signal: AbortSignal,
  ): Promise<CuaAgentAuthority>;
  publish: CuaAgentApprovalPublisher;
}): CuaMcpExecutor {
  const registrations = new WeakMap<AbortSignal, Promise<void>>();
  return async (binding, request, requestId, signal) => {
    const native = options.resolve({
      chatId: binding.chatId,
      threadId: request.threadId,
      turnId: request.turnId,
    });
    if (native) {
      let ready = registrations.get(native.signal);
      if (!ready) {
        ready = (async () => {
          const authority = await options.authority(
            binding,
            AbortSignal.any([signal, native.signal]),
          );
          native.signal.throwIfAborted();
          const release = options.coordinator.register({
            initialAuthority: authority,
            ownerId: authority.ownerId,
            serverId: authority.serverId,
            workerId: binding.workerId,
            chatId: binding.chatId,
            projectId: binding.projectId,
            contextKind: binding.contextKind,
            placementId:
              binding.contextKind === "project"
                ? binding.worktreeId
                : binding.scratchRootId,
            executionLaneId: binding.executionLaneId,
            taskId: null,
            rootThreadId: native.rootThreadId,
            ownsThread: (threadId) => threadId === native.rootThreadId,
            resolve: options.resolve,
            publish: options.publish,
          });
          native.signal.addEventListener(
            "abort",
            () => {
              void release().catch(() => {});
            },
            { once: true },
          );
        })();
        registrations.set(native.signal, ready);
        void ready.catch(() => registrations.delete(native.signal));
      }
      await ready;
    }
    return options.coordinator.execute(binding, request, requestId, signal);
  };
}
