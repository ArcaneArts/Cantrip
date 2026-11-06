import {
  chatInterruptAcceptedSchema,
  type NativeSuspensionRecord,
  type WorkerCommand,
} from "@cantrip/protocol";
import type { ChatExecutionContext } from "../../db/repository.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { prepareManagedTurnLaunch } from "../../terminals/managed-session.js";
import type { ChatExecutionControlRouteDependencies } from "../routes/chat-execution-control.js";
import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export class DurableChatStopError extends Error {}
type Dependencies = Omit<
  ChatExecutionControlRouteDependencies,
  "applicationOwnerId" | "interruptLiveAgentInteractionRequests"
>;
type Control = Awaited<
  ReturnType<Dependencies["repository"]["nativeCommands"]["controlContext"]>
>;

/** Stop fences Resume before requesting any worker attachment. The worker may
 * use its surviving observer or acquire a fresh, held observer for this Stop. */
export function createDurableChatStopRuntime(dependencies: Dependencies) {
  const {
    repository,
    bridge,
    runtimeForContext,
    routePairsForConfiguration,
    publishChatSummary,
  } = dependencies;
  const pending = new Map<string, Promise<{ interrupted: boolean }>>();
  const terminal = (state: NativeSuspensionRecord) =>
    ["stopped", "completed", "failed", "idle"].includes(state.phase);
  return async (
    owner: string,
    context: ChatExecutionContext,
    control: Control,
    saved: NativeSuspensionRecord,
  ) => {
    const requested = await repository.nativeSuspensions.request(
      owner,
      context.chatId,
      "stop",
      saved.active ?? undefined,
    );
    if (terminal(requested.state)) return { interrupted: true };
    const key = JSON.stringify([
      owner,
      context.chatId,
      requested.state.controlId,
    ]);
    const joined = pending.get(key);
    if (joined) return joined;
    const execute = async () => {
      try {
        if (control.activationGeneration) {
          try {
            chatInterruptAcceptedSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "chat.native-control",
                  chatId: context.chatId,
                  threadId: context.threadId,
                  nativeActivationGeneration: control.activationGeneration,
                  nativeRuntimeGeneration: control.runtimeGeneration,
                  modelRouteId: context.modelRouteId,
                  providerAccountId: context.providerAccountId,
                  control: { kind: "interrupt" },
                },
                { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
              ),
            );
          } catch {
            // An absent surviving owner leaves this control unclaimed. A
            // claimed native attempt keeps its own acknowledgement/retry path.
          }
          const observed = await repository.nativeSuspensions.read(
            owner,
            context.chatId,
          );
          if (observed?.controlId !== requested.state.controlId)
            throw new DurableChatStopError(
              "This Stop was superseded by a newer control.",
            );
          if (terminal(observed)) return { interrupted: true };
          if (observed.actorControlId === observed.controlId)
            throw new DurableChatStopError(
              "The native Stop has not received a committed acknowledgement. Retry Stop.",
            );
        }
        const runtime = await runtimeForContext(context);
        if (!runtime)
          throw new DurableChatStopError(
            "The saved runtime is unavailable. Restore it and retry Stop.",
          );
        const launch = await prepareManagedTurnLaunch(context, runtime, {
          ownerId: owner,
          bridge,
          repository,
          routePairsForConfiguration,
        });
        const checkpoint = requested.state.checkpoint;
        if (
          !launch.session ||
          !launch.threadId ||
          !checkpoint ||
          launch.threadId !== requested.state.active?.threadId
        )
          throw new DurableChatStopError(
            "The saved turn no longer matches its chat attachment. Restore its placement and retry Stop.",
          );
        const command: Extract<
          WorkerCommand,
          { type: "chat.suspension.stop" }
        > = {
          type: "chat.suspension.stop",
          chatId: context.chatId,
          threadId: launch.threadId,
          controlId: requested.state.controlId,
          checkpoint,
          nativeActivationGeneration: control.activationGeneration,
          nativeRuntimeGeneration: control.runtimeGeneration,
          session: { ...launch.session, heldSuspension: checkpoint },
          cwd: context.cwd,
          executionProfile:
            context.contextKind === "standalone" ? "standalone-chat" : "ide",
          model: launch.model,
          provider: launch.provider,
          permissionProfileId:
            launch.permissionProfileId ??
            effectivePermissionProfile(context).effectiveId,
          planMode: launch.planMode ?? context.planMode,
          subagentDefaults: launch.subagentDefaults ?? null,
          mcpServers: launch.mcpServers ?? [],
        };
        const result = chatInterruptAcceptedSchema.parse(
          await bridge.request(context.workerId, command, {
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
          }),
        );
        const state = await repository.nativeSuspensions.read(
          owner,
          context.chatId,
        );
        if (
          !result.interrupted ||
          !state ||
          state.controlId !== requested.state.controlId ||
          !terminal(state)
        )
          throw new DurableChatStopError(
            "Stop has not received a committed native acknowledgement. Retry Stop.",
          );
        return result;
      } catch (error) {
        const current = await repository.nativeSuspensions.read(
          owner,
          context.chatId,
        );
        if (current?.controlId === requested.state.controlId) {
          if (terminal(current)) return { interrupted: true };
          await repository.nativeSuspensions.failedControl(
            owner,
            context.chatId,
            current.controlId,
            current.actor,
            { code: "stop-failed", protectedDetails: null },
          );
        }
        throw error instanceof DurableChatStopError
          ? error
          : new DurableChatStopError(
              "The suspended turn could not be stopped. Its saved state is retained; retry Stop.",
            );
      } finally {
        publishChatSummary(context.chatId, context.projectId);
      }
    };
    const result = execute();
    pending.set(key, result);
    const clear = () => {
      if (pending.get(key) === result) pending.delete(key);
    };
    void result.then(clear, clear);
    return result;
  };
}
