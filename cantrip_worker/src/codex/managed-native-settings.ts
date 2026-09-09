import { z } from "zod";
import type {
  NativeSettingsDelivery,
  NativeSettingsEvidenceScope,
} from "../native-settings-delivery.js";
import type { CodexAppServer } from "./app-server.js";
import type { NativeHistorySubscription } from "./native-history-observation.js";
import { nativeThreadSettingsSchema } from "./native-thread-settings.js";

const updated = z.object({
  threadId: z.string(),
  operationId: z.string(),
  submissionId: z.string().min(1),
  threadSettings: nativeThreadSettingsSchema,
});
const failed = z.object({
  threadId: z.string(),
  turnId: z.string().min(1),
  willRetry: z.literal(false),
  error: z
    .object({
      codexErrorInfo: z.object({
        threadSettingsUpdateFailed: z.object({
          operationId: z.string().nullable(),
        }),
      }),
    })
    .passthrough(),
});
const queued = z.object({
  operationId: z.string(),
  submissionId: z.string().min(1),
});

/** One raw observer for the managed thread; no snapshot or synthetic model turn. */
export class ManagedNativeSettings {
  private subscription: NativeHistorySubscription | null = null;
  private readonly commands = new Map<
    string,
    { scope: NativeSettingsEvidenceScope; submissionId: string | null }
  >();
  constructor(
    private readonly options: {
      runtime: Pick<CodexAppServer, "observeNativeHistory">;
      delivery: Pick<NativeSettingsDelivery, "track" | "record">;
      onError(error: unknown, operationId: string): void;
    },
  ) {}

  async track(scope: NativeSettingsEvidenceScope): Promise<void> {
    if (this.commands.has(scope.nativeOperationId))
      throw new Error(
        "Native settings operation identity was reused in this session.",
      );
    if (!this.subscription) {
      this.subscription = this.options.runtime.observeNativeHistory(
        scope.threadId,
        {
          capture: (event) => this.observe(event.method, event.params),
          onError: (error) => this.options.onError(error, scope.operationId),
        },
      );
      this.subscription.signal.addEventListener(
        "abort",
        () => {
          for (const command of this.commands.values())
            void this.options.delivery
              .record(command.scope, "transport-lost", command.submissionId, {
                reason: "native-transport-closed",
              })
              .catch((error) =>
                this.options.onError(error, command.scope.operationId),
              );
        },
        { once: true },
      );
    }
    this.subscription.signal.throwIfAborted();
    if (this.subscription.generation !== scope.runtimeGeneration)
      throw new Error("Native settings belongs to a replaced transport.");
    await this.options.delivery.track(scope);
    this.commands.set(scope.nativeOperationId, { scope, submissionId: null });
  }

  private async observe(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === "thread/settings/updated") {
      const parsed = updated.safeParse(params);
      if (!parsed.success) return;
      const command = this.commands.get(parsed.data.operationId);
      if (!command || command.scope.threadId !== parsed.data.threadId) return;
      command.submissionId ??= parsed.data.submissionId;
      await this.options.delivery.record(
        command.scope,
        "applied",
        parsed.data.submissionId,
        params,
      );
    } else if (method === "error") {
      const parsed = failed.safeParse(params);
      if (!parsed.success) return;
      const nativeOperationId =
        parsed.data.error.codexErrorInfo.threadSettingsUpdateFailed.operationId;
      // Older uncorrelated errors cannot prove a particular request failed.
      const command = nativeOperationId
        ? this.commands.get(nativeOperationId)
        : undefined;
      if (!command || command.scope.threadId !== parsed.data.threadId) return;
      command.submissionId ??= parsed.data.turnId;
      await this.options.delivery.record(
        command.scope,
        "rejected",
        parsed.data.turnId,
        params,
      );
    }
  }

  async acknowledge(
    nativeOperationId: string,
    frame: Record<string, unknown> | null,
  ): Promise<void> {
    const command = this.commands.get(nativeOperationId);
    if (!command) return; // Dispatch failed before registration/native input.
    if (!frame) {
      await this.options.delivery.record(
        command.scope,
        "transport-lost",
        command.submissionId,
        { reason: "native-response-unavailable" },
      );
    } else if ("error" in frame) {
      await this.options.delivery.record(
        command.scope,
        "rejected",
        command.submissionId,
        frame,
      );
    } else {
      const parsed = queued.safeParse(frame.result);
      if (!parsed.success || parsed.data.operationId !== nativeOperationId) {
        await this.options.delivery.record(
          command.scope,
          "correlation-conflict",
          command.submissionId,
          frame,
        );
      } else {
        command.submissionId ??= parsed.data.submissionId;
        await this.options.delivery.record(
          command.scope,
          "queued",
          parsed.data.submissionId,
          frame,
        );
      }
    }
  }
}
