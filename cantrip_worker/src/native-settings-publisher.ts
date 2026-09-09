import { isDeepStrictEqual } from "node:util";
import type {
  NativeSettingsBinding,
  NativeSettingsReadScope,
  ProtectedNativeSettingsSnapshot,
} from "@cantrip/protocol";
import type { CodexAppServer } from "./codex/app-server.js";
import {
  nativeThreadSettingsSchema,
  type NativeThreadSettings,
} from "./codex/native-thread-settings.js";
import type { NativeHistorySubscription } from "./codex/native-history-observation.js";
import type { NativeCommandClient } from "./native-command-client.js";
import { CantripServerRequestError } from "./cli-client.js";
import { protectNativeSettingsSnapshot } from "./native-settings-content.js";

interface PendingSnapshot {
  sequence: number;
  settings: NativeThreadSettings;
  sealed?: { bindingId: string; snapshot: ProtectedNativeSettingsSnapshot };
}

/** Latest effective state is recoverable through a fresh native read. Historical
 * operation outcomes use the separate durable evidence journal. This observer
 * never performs input, replays a command, or owns the native turn lifetime. */
export class NativeSettingsPublisher {
  private readonly lifetime = new AbortController();
  private subscription: NativeHistorySubscription | null = null;
  private binding: NativeSettingsBinding | null = null;
  private latest: PendingSnapshot | null = null;
  private sequence = 0;
  private pumping = false;
  private attempt: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private refreshGeneration = 0;
  private identity: { ownerId: string; serverId: string } | null = null;

  constructor(
    private readonly options: {
      scope: NativeSettingsReadScope;
      generation: string;
      runtime: Pick<CodexAppServer, "observeNativeHistory">;
      isCurrent(): boolean;
      service: Parameters<typeof protectNativeSettingsSnapshot>[0]["service"];
      client: Pick<NativeCommandClient, "refreshSettings" | "observeSettings">;
      /** Actual server binding from a fresh native settings read, before publication resumes. */
      onBinding?(
        binding: NativeSettingsBinding,
        signal: AbortSignal,
      ): Promise<void>;
      onError(error: unknown): void;
      retryDelayMs?: number;
    },
  ) {}

  get closed(): boolean {
    return this.lifetime.signal.aborted;
  }

  start(): void {
    if (this.subscription || this.lifetime.signal.aborted) return;
    try {
      this.identity = {
        ownerId: this.options.service.ownerId(),
        serverId: this.options.service.serverIdentity(),
      };
      this.subscription = this.options.runtime.observeNativeHistory(
        this.options.scope.threadId,
        {
          capture: (event) => {
            if (
              event.method !== "thread/settings/updated" ||
              event.generation !== this.options.generation ||
              event.threadId !== this.options.scope.threadId ||
              !this.current()
            )
              return;
            try {
              const settings = nativeThreadSettingsSchema.parse(
                event.params.threadSettings,
              );
              if (!settings.settingsVersion)
                throw new Error("Native settings notification has no version.");
              const previous = this.latest?.settings.settingsVersion;
              if (
                previous?.epoch === settings.settingsVersion.epoch &&
                BigInt(previous.revision) >
                  BigInt(settings.settingsVersion.revision)
              )
                return;
              this.latest = { sequence: ++this.sequence, settings };
              this.kick();
            } catch (error) {
              this.binding = null;
              this.refreshGeneration += 1;
              this.failed(error);
            }
          },
          onError: (error) => {
            this.binding = null;
            this.refreshGeneration += 1;
            this.failed(error);
          },
        },
      );
      this.subscription.signal.addEventListener("abort", () => this.close(), {
        once: true,
      });
      if (this.subscription.signal.aborted) this.close();
      this.kick();
    } catch (error) {
      this.failed(error);
    }
  }

  /** Reconcile server restart/reconnect without reconstructing or replaying input. */
  wake(): void {
    this.attempt?.abort();
    this.refreshGeneration += 1;
    this.binding = null;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.kick();
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.subscription?.close();
    this.subscription = null;
    this.latest = null;
    this.binding = null;
  }

  private current(): boolean {
    if (this.lifetime.signal.aborted) return false;
    try {
      if (
        this.options.isCurrent() &&
        (!this.identity ||
          (this.identity.ownerId === this.options.service.ownerId() &&
            this.identity.serverId === this.options.service.serverIdentity()))
      )
        return true;
    } catch {
      /* Locked/replaced encryption identity retires only this observer. */
    }
    this.close();
    return false;
  }

  private kick(): void {
    if (this.pumping || this.retry || !this.current()) return;
    this.pumping = true;
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.lifetime.signal, attempt.signal]);
    void this.pump(signal)
      .catch((error) => {
        if (!signal.aborted) this.failed(error);
      })
      .finally(() => {
        if (this.attempt === attempt) this.attempt = null;
        this.pumping = false;
        if (!this.retry && this.current() && (!this.binding || this.latest))
          this.kick();
      });
  }

  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.current()) {
      if (!this.binding) {
        const sequence = this.sequence;
        const refreshGeneration = this.refreshGeneration;
        const state = await this.options.client.refreshSettings(
          this.options.scope.chatId,
          signal,
        );
        if (signal.aborted || !this.current()) return;
        if (refreshGeneration !== this.refreshGeneration) continue;
        const binding = state.binding;
        if (!binding || !state.effective)
          throw new Error(
            "Native settings refresh returned no bound snapshot.",
          );
        const {
          bindingId: _id,
          runtimeGeneration,
          nativeEpoch: _epoch,
          ...scope
        } = binding;
        if (
          runtimeGeneration !== this.options.generation ||
          !isDeepStrictEqual(scope, this.options.scope)
        ) {
          this.close(); // A different managed source now owns this chat.
          return;
        }
        await this.options.onBinding?.(binding, signal);
        if (signal.aborted || !this.current()) return;
        if (refreshGeneration !== this.refreshGeneration) continue;
        this.binding = binding;
        if (
          this.latest?.settings.settingsVersion?.epoch !== binding.nativeEpoch
        ) {
          if (this.latest && this.latest.sequence > sequence) {
            this.binding = null;
            continue;
          }
          this.latest = null; // The actual read supersedes older buffered sources.
        }
        this.failures = 0;
      }
      const pending = this.latest;
      if (!pending) return;
      const binding = this.binding;
      const version = pending.settings.settingsVersion!;
      if (version.epoch !== binding.nativeEpoch) {
        this.binding = null;
        continue;
      }
      if (!pending.sealed || pending.sealed.bindingId !== binding.bindingId) {
        pending.sealed = {
          bindingId: binding.bindingId,
          snapshot: await protectNativeSettingsSnapshot({
            service: this.options.service,
            settings: pending.settings,
            context: {
              chatId: binding.chatId,
              workerId: binding.workerId,
              threadId: binding.threadId,
              runtimeGeneration: binding.runtimeGeneration,
              settingsVersion: version,
            },
          }),
        };
      }
      if (signal.aborted || !this.current()) return;
      await this.options.client.observeSettings(pending.sealed, signal);
      if (signal.aborted || !this.current()) return;
      if (this.latest === pending) this.latest = null;
      this.failures = 0;
    }
  }

  private failed(error: unknown): void {
    if (!this.current()) return;
    if (
      error instanceof CantripServerRequestError &&
      error.code === "settings-binding-replaced"
    ) {
      this.binding = null;
      this.refreshGeneration += 1;
    }
    try {
      this.options.onError(error);
    } catch {
      /* Observation diagnostics cannot affect input. */
    }
    if (!this.retry) {
      const delay = Math.min(
        10_000,
        (this.options.retryDelayMs ?? 500) * 2 ** Math.min(this.failures++, 5),
      );
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!this.subscription) this.start();
        else this.kick();
      }, delay);
      this.retry.unref?.();
    }
  }
}
