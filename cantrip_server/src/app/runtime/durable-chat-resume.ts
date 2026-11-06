import type { FastifyInstance } from "fastify";
import {
  chatNativeSuspension,
  chatPauseRuntimeStateSchema,
  nativeSuspensionErrorSchema,
  type NativeSuspensionRecord,
  type ChatPauseRuntimeState,
  type NativeSuspensionError,
  type WorkerCommand,
} from "@cantrip/protocol";
import type { ChatExecutionContext } from "../../db/repository.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import { prepareManagedTurnLaunch } from "../../terminals/managed-session.js";
import type { ChatAutomationPauseRouteDependencies } from "./chat-automation-pause-runtime.js";
import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export class DurableChatResumeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: NativeSuspensionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DurableChatResumeError";
  }
}
type Dependencies = Omit<
  ChatAutomationPauseRouteDependencies,
  "applicationOwnerId"
>;
type Control = Awaited<
  ReturnType<Dependencies["repository"]["nativeCommands"]["controlContext"]>
>;

/** Explicit intent owns recovery; opening a chat never calls this service. */
export function createDurableChatResumeRuntime(
  dependencies: Dependencies,
  app: Pick<FastifyInstance, "log">,
) {
  const {
    repository,
    bridge,
    publishChatSummary,
    resumeChatAutomation,
    runtimeForContext,
    routePairsForConfiguration,
  } = dependencies;
  const pending = new Map<string, Promise<ChatPauseRuntimeState>>();
  const latest = async (owner: string, chat: string) => {
    const [context, state] = await Promise.all([
      repository.getChatExecutionContext(owner, chat),
      repository.nativeSuspensions.read(owner, chat),
    ]);
    if (!context || !state)
      throw new DurableChatResumeError(
        404,
        "restore-failed",
        "The suspended chat is no longer available.",
      );
    return { context, state };
  };
  const result = ({ context, state }: Awaited<ReturnType<typeof latest>>) => ({
    paused: context.automationPaused,
    active: state.active,
    nativeSuspension: chatNativeSuspension(state),
  });
  const completed = (state: NativeSuspensionRecord) =>
    ["running", "stopped", "completed", "failed", "idle"].includes(state.phase);

  return async (
    owner: string,
    context: ChatExecutionContext,
    control: Control,
    saved: NativeSuspensionRecord,
    resumeAutomation: boolean,
  ): Promise<ChatPauseRuntimeState> => {
    let requested: Awaited<
      ReturnType<Dependencies["repository"]["nativeSuspensions"]["request"]>
    >;
    try {
      requested = await repository.nativeSuspensions.request(
        owner,
        context.chatId,
        "resume",
        saved.active ?? undefined,
      );
    } catch (error) {
      const current = await latest(owner, context.chatId);
      if (completed(current.state) || current.state.action === "stop")
        return result(current);
      throw error;
    }
    const key = JSON.stringify([
      owner,
      context.chatId,
      requested.state.controlId,
    ]);
    const joined = pending.get(key);
    if (joined) return joined;
    const execute = async (): Promise<ChatPauseRuntimeState> => {
      const current = () => latest(owner, context.chatId);
      const finish = async (observed: Awaited<ReturnType<typeof latest>>) => {
        publishChatSummary(context.chatId, context.projectId);
        if (
          resumeAutomation &&
          observed.state.controlId === requested.state.controlId &&
          observed.state.phase === "running" &&
          !observed.context.automationPaused
        ) {
          try {
            await resumeChatAutomation(context.chatId);
          } catch {
            // Resume already has real native acknowledgement. Retained queued
            // automation can retry without rewriting that execution's pause state.
            app.log.warn(
              {
                event: "chat.suspension.automation-wake-failed",
                chatId: context.chatId,
              },
              "The turn resumed but queued automation remains pending",
            );
          }
        }
        return result(observed);
      };
      let failure: unknown;
      // Try the real surviving owner first. Older workers retain this fast path;
      // an absent transport fails before native dispatch and leaves cold recovery held.
      if (control.activationGeneration) {
        try {
          chatPauseRuntimeStateSchema.parse(
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
                control: { kind: "pause", paused: false },
              },
              { timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS },
            ),
          );
        } catch (error) {
          failure = error;
        }
      }
      let observed = await current();
      if (
        observed.state.controlId !== requested.state.controlId ||
        completed(observed.state)
      )
        return finish(observed);
      // A claimed actual native attempt has its own receipt/error semantics.
      // Do not replace uncertain execution with another automatic restoration.
      if (
        observed.state.phase === "resuming" &&
        observed.state.actorControlId !== observed.state.controlId
      ) {
        try {
          const runtime = await runtimeForContext(context);
          if (!runtime)
            throw new DurableChatResumeError(
              409,
              "runtime-unavailable",
              "The saved provider route is unavailable. This chat remains paused.",
            );
          const launch = await prepareManagedTurnLaunch(context, runtime, {
            ownerId: owner,
            bridge,
            repository,
            routePairsForConfiguration,
          });
          if (
            !launch.session ||
            !launch.threadId ||
            !requested.state.checkpoint
          )
            throw new DurableChatResumeError(
              409,
              "authority-changed",
              "The saved turn no longer matches its managed chat attachment.",
            );
          const command: Extract<
            WorkerCommand,
            { type: "chat.suspension.resume" }
          > = {
            type: "chat.suspension.resume",
            chatId: context.chatId,
            threadId: launch.threadId,
            controlId: requested.state.controlId,
            checkpoint: requested.state.checkpoint,
            nativeActivationGeneration: control.activationGeneration,
            nativeRuntimeGeneration: control.runtimeGeneration,
            session: {
              ...launch.session,
              heldSuspension: requested.state.checkpoint,
            },
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
          chatPauseRuntimeStateSchema.parse(
            await bridge.request(context.workerId, command, {
              timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
            }),
          );
          failure = undefined;
        } catch (error) {
          failure = error;
        }
        observed = await current();
      }
      if (
        observed.state.controlId !== requested.state.controlId ||
        completed(observed.state)
      ) {
        return finish(observed);
      }
      if (observed.state.phase === "resuming") {
        const rawCode =
          failure && typeof failure === "object"
            ? Reflect.get(failure, "code")
            : null;
        const parsed = nativeSuspensionErrorSchema.safeParse({
          code: rawCode,
          protectedDetails: null,
        });
        const code = !bridge.isConnected(context.workerId)
          ? "worker-offline"
          : parsed.success
            ? parsed.data.code
            : "restore-failed";
        try {
          await repository.nativeSuspensions.failedControl(
            owner,
            context.chatId,
            observed.state.controlId,
            observed.state.actor,
            { code, protectedDetails: null },
          );
        } catch {
          // A later actor/control can win while its predecessor reports failure.
        }
        observed = await current();
      }
      publishChatSummary(context.chatId, context.projectId);
      if (
        observed.state.controlId !== requested.state.controlId ||
        completed(observed.state)
      )
        return finish(observed);
      app.log.warn(
        {
          event: "chat.suspension.resume-failed",
          chatId: context.chatId,
          controlId: requested.state.controlId,
          errorCode: observed.state.error?.code ?? "restore-failed",
        },
        "The suspended native turn remains held",
      );
      if (failure instanceof DurableChatResumeError) throw failure;
      throw new DurableChatResumeError(
        502,
        observed.state.error?.code ?? "restore-failed",
        "The worker could not resume this saved turn. Its checkpoint has been retained.",
      );
    };
    const operation = execute();
    pending.set(key, operation);
    const clear = () => {
      if (pending.get(key) === operation) pending.delete(key);
    };
    void operation.then(clear, clear);
    return operation;
  };
}
