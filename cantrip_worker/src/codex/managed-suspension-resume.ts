import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ChatPauseRuntimeState,
  NativeCommandSession,
  NativeSuspensionError,
  WorkerCommand,
} from "@cantrip/protocol";
import type { NativeCommandClient } from "../native-command-client.js";
import { protectNativeCommandContent } from "../native-command-content.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { CodexAppServer } from "./app-server.js";
import type { ManagedNativeCommandSession } from "./managed-native-command-session.js";
import {
  ManagedSuspensionSourceError,
  type openManagedSuspensionSource,
} from "./managed-suspended-source.js";

export type ManagedSuspensionResumeCommand = Extract<
  WorkerCommand,
  { type: "chat.suspension.resume" }
>;
export type ManagedSuspensionStopCommand = Extract<
  WorkerCommand,
  { type: "chat.suspension.stop" }
>;
export type ManagedSuspensionControlCommand =
  ManagedSuspensionResumeCommand | ManagedSuspensionStopCommand;
export interface ManagedSuspensionResumeTarget {
  runtime: Pick<
    CodexAppServer,
    "setActiveChatPaused" | "isChatPaused" | "interruptChat"
  >;
  adapter: Pick<
    ManagedNativeCommandSession,
    | "currentActivationGeneration"
    | "restoreSuspendedExecution"
    | "withExpectedActivationGeneration"
  >;
  session: NativeCommandSession;
}
export class ManagedSuspensionResumeError extends Error {
  constructor(
    readonly code: NativeSuspensionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ManagedSuspensionResumeError";
  }
}
interface Ports {
  client: Pick<NativeCommandClient, "admitSuspendedExecution">;
  encryption: Pick<
    WorkerEncryptionService,
    "ownerId" | "serverIdentity" | "componentKey"
  >;
  signal(): AbortSignal;
  active(
    command: ManagedSuspensionControlCommand,
  ): ManagedSuspensionResumeTarget | null;
  prepare(
    command: ManagedSuspensionControlCommand,
  ): Promise<ManagedSuspensionResumeTarget>;
  openSource(
    command: ManagedSuspensionControlCommand,
  ): ReturnType<typeof openManagedSuspensionSource>;
}

/** One explicit control at a time per chat. Different epochs wait for actual
 * prior preparation/dispatch settlement, while Stop remains on its own path.
 * No operation, key or admission is serialized into this local coordination. */
export class ManagedSuspensionResumes {
  private readonly stopping = new Map<
    string,
    Promise<{ interrupted: boolean }>
  >();
  private readonly pending = new Map<
    string,
    {
      signature: unknown;
      result: Promise<ChatPauseRuntimeState>;
    }
  >();
  constructor(private readonly ports: Ports) {}

  stop(
    command: ManagedSuspensionStopCommand,
  ): Promise<{ interrupted: boolean }> {
    const key = JSON.stringify([
      command.controlId,
      command.chatId,
      command.threadId,
      command.checkpoint,
      command.cwd,
      command.session.contextKind,
      command.session.projectId,
      command.session.contextKind === "project"
        ? command.session.worktreeId
        : command.session.scratchRootId,
      command.model.routeId ?? null,
      command.provider.accountId ?? null,
    ]);
    const prior = this.stopping.get(key);
    if (prior) return prior;
    // Stop does not queue behind pending Resume or resource restoration. Its
    // server control epoch fences that attempt before this worker is contacted.
    const result = this.execute(command).then(() => ({ interrupted: true }));
    this.stopping.set(key, result);
    const clear = () => {
      if (this.stopping.get(key) === result) this.stopping.delete(key);
    };
    void result.then(clear, clear);
    return result;
  }

  run(command: ManagedSuspensionResumeCommand): Promise<ChatPauseRuntimeState> {
    const source = command.session;
    const signature = structuredClone([
      command.controlId,
      command.threadId,
      command.checkpoint,
      command.cwd,
      source.contextKind,
      source.projectId,
      source.contextKind === "project"
        ? source.worktreeId
        : source.scratchRootId,
      command.model.routeId ?? null,
      command.provider.accountId ?? null,
    ]);
    const previous = this.pending.get(command.chatId);
    if (previous && isDeepStrictEqual(previous.signature, signature))
      return previous.result;
    const result = Promise.resolve(previous?.result)
      .catch(() => {})
      .then(() => this.execute(command));
    const entry = { signature, result };
    this.pending.set(command.chatId, entry);
    const clear = () => {
      if (this.pending.get(command.chatId) === entry)
        this.pending.delete(command.chatId);
    };
    void result.then(clear, clear);
    return result;
  }

  private async execute(
    command: ManagedSuspensionControlCommand,
  ): Promise<ChatPauseRuntimeState> {
    const stopping = command.type === "chat.suspension.stop";
    const signal = this.ports.signal();
    signal.throwIfAborted();
    try {
      let target = this.ports.active(command);
      if (!target) {
        target = await this.ports.prepare(command);
        signal.throwIfAborted();
        const opened = await this.ports.openSource(command);
        if (!opened?.continuation)
          throw new ManagedSuspensionResumeError(
            "checkpoint-incompatible",
            "This saved turn does not contain durable worker bookkeeping. Its checkpoint has been retained.",
          );
        const operationId = randomUUID();
        const payload = await protectNativeCommandContent({
          service: this.ports.encryption,
          context: {
            chatId: command.chatId,
            operationId,
            direction: "request",
          },
          content: {
            method: "thread/resume",
            params: {
              threadId: command.threadId,
              expectedSuspension: command.checkpoint.suspension,
            },
          },
        });
        const grant = await this.ports.client.admitSuspendedExecution(
          {
            ...(stopping ? { action: "stop" as const } : {}),
            operationId,
            controlId: command.controlId,
            checkpoint: command.checkpoint,
            session: target.session,
            payloadDigest: payload.digest,
            protectedPayload: payload.envelope,
          },
          signal,
        );
        const observer = await target.adapter.restoreSuspendedExecution(
          grant,
          target.session,
          opened.continuation,
          signal,
        );
        observer.assertCurrent();
      }
      signal.throwIfAborted();
      const generation = target.adapter.currentActivationGeneration;
      return await target.adapter.withExpectedActivationGeneration(
        generation,
        async () => {
          if (stopping) {
            const result = await target.runtime.interruptChat(
              command.chatId,
              command.threadId,
            );
            if (!result.interrupted)
              throw new ManagedSuspensionResumeError(
                "stop-failed",
                "The named native turn did not acknowledge Stop.",
              );
            return {
              paused: target.runtime.isChatPaused(command.chatId),
              active: null,
            };
          }
          const active = await target.runtime.setActiveChatPaused(
            command.chatId,
            false,
          );
          return {
            paused: target.runtime.isChatPaused(command.chatId),
            active,
          };
        },
        command.controlId,
      );
    } catch (error) {
      if (
        error instanceof ManagedSuspensionSourceError ||
        error instanceof ManagedSuspensionResumeError
      )
        throw error;
      // Native diagnostics can contain private worker paths. The saved record
      // and its actual native checkpoint remain available for explicit recovery.
      throw new ManagedSuspensionResumeError(
        stopping ? "stop-failed" : "restore-failed",
        stopping
          ? "The suspended native turn could not be stopped. Its saved state has been retained."
          : "The suspended native turn could not be resumed. Its saved state has been retained.",
      );
    }
  }
}
