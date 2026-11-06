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
export interface ManagedSuspensionResumeTarget {
  runtime: Pick<CodexAppServer, "setActiveChatPaused" | "isChatPaused">;
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
    command: ManagedSuspensionResumeCommand,
  ): ManagedSuspensionResumeTarget | null;
  prepare(
    command: ManagedSuspensionResumeCommand,
  ): Promise<ManagedSuspensionResumeTarget>;
  openSource(
    command: ManagedSuspensionResumeCommand,
  ): ReturnType<typeof openManagedSuspensionSource>;
}

/** One explicit control at a time per chat. Different epochs wait for actual
 * prior preparation/dispatch settlement, while Stop remains on its own path.
 * No operation, key or admission is serialized into this local coordination. */
export class ManagedSuspensionResumes {
  private readonly pending = new Map<
    string,
    {
      signature: unknown;
      result: Promise<ChatPauseRuntimeState>;
    }
  >();
  constructor(private readonly ports: Ports) {}

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
    command: ManagedSuspensionResumeCommand,
  ): Promise<ChatPauseRuntimeState> {
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
        "restore-failed",
        "The suspended native turn could not be resumed. Its saved state has been retained.",
      );
    }
  }
}
