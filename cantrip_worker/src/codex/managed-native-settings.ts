import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  NativeThreadSettings,
  PermissionTransition,
  NativeSettingsEvidence,
  NativeSettingsBinding,
} from "@cantrip/protocol";
import { confirmedNativePermissionClaim } from "./managed-native-permissions.js";
import type {
  NativeSettingsDelivery,
  NativeSettingsEvidenceScope,
  NativePermissionRegistrationSource,
} from "../native-settings-delivery.js";
import { CodexNativeRpcError, type CodexAppServer } from "./app-server.js";
import type { NativeHistorySubscription } from "./native-history-observation.js";
import { nativeThreadSettingsSchema } from "./native-thread-settings.js";

const updated = z.object({
  threadId: z.string(),
  operationId: z.string(),
  submissionId: z.string().min(1),
  threadSettings: nativeThreadSettingsSchema,
  resolvedSecurity: z.unknown().optional(),
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
  private recovery: Promise<void> | null = null;
  private unsubscribePublished: (() => void) | undefined;
  private readonly commands = new Map<
    string,
    {
      scope: NativeSettingsEvidenceScope;
      submissionId: string | null;
      transition?: PermissionTransition;
      applied?: NativeThreadSettings;
      recoveryBindingId?: string;
      publicationScope?: NativeSettingsEvidenceScope;
      recoveryComplete?: boolean;
      rejection?: { submissionId: string | null; content: unknown };
      phase?: "registering" | "queued" | "uncertain" | "applied" | "rejected";
    }
  >();
  constructor(
    private readonly options: {
      runtime: Pick<CodexAppServer, "observeNativeHistory">;
      delivery: Pick<NativeSettingsDelivery, "track" | "record"> &
        Partial<
          Pick<
            NativeSettingsDelivery,
            "subscribePublished" | "permissionRegistrations"
          >
        >;
      onPermissionApplied?(
        scope: NativeSettingsEvidenceScope,
        transition: PermissionTransition,
        settings: NativeThreadSettings,
      ): Promise<void> | void;
      onPermissionRejected?(
        scope: NativeSettingsEvidenceScope,
        transition: PermissionTransition,
      ): Promise<void> | void;
      onError(error: unknown, operationId: string): void;
    },
  ) {}

  private async published(event: NativeSettingsEvidence): Promise<void> {
    const command = this.commands.get(event.nativeOperationId);
    if (
      !command?.transition ||
      command.scope.operationId !== event.operationId ||
      command.scope.operationGeneration !== event.operationGeneration ||
      command.scope.runtimeGeneration !== event.runtimeGeneration ||
      command.scope.threadId !== event.threadId
    )
      return;
    if (event.kind === "rejected") {
      await this.options.onPermissionRejected?.(
        command.publicationScope ?? command.scope,
        command.transition,
      );
      return;
    }
    if (!command.applied) return;
    await this.options.onPermissionApplied?.(
      command.publicationScope ?? command.scope,
      command.transition,
      command.applied,
    );
  }

  private ensureObservation(scope: NativeSettingsEvidenceScope): void {
    if (!this.subscription || this.subscription.signal.aborted) {
      this.unsubscribePublished = this.options.delivery.subscribePublished?.(
        (event) => this.published(event),
      );
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
          this.unsubscribePublished?.();
          this.unsubscribePublished = undefined;
          for (const command of this.commands.values()) {
            if (command.transition) continue;
            void this.options.delivery
              .record(command.scope, "transport-lost", command.submissionId, {
                reason: "native-transport-closed",
              })
              .catch((error) =>
                this.options.onError(error, command.scope.operationId),
              );
          }
        },
        { once: true },
      );
    }
  }

  async track(
    scope: NativeSettingsEvidenceScope,
    transition?: PermissionTransition,
    source?: NativePermissionRegistrationSource,
  ): Promise<void> {
    if (this.commands.has(scope.nativeOperationId))
      throw new Error(
        "Native settings operation identity was reused in this session.",
      );
    this.subscription?.signal.throwIfAborted();
    this.ensureObservation(scope);
    this.subscription!.signal.throwIfAborted();
    if (this.subscription!.generation !== scope.runtimeGeneration)
      throw new Error("Native settings belongs to a replaced transport.");
    if (transition && !source)
      throw new Error(
        "Permission recovery requires the admitted native source.",
      );
    if (transition)
      await this.options.delivery.track(scope, { transition, source: source! });
    else await this.options.delivery.track(scope);
    const recovered = this.commands.get(scope.nativeOperationId);
    if (recovered) {
      if (
        !isDeepStrictEqual(recovered.scope, scope) ||
        !isDeepStrictEqual(recovered.transition, transition)
      )
        throw new Error(
          "Native settings operation identity changed during registration.",
        );
      return;
    }
    this.commands.set(scope.nativeOperationId, {
      scope,
      submissionId: null,
      phase: "registering",
      ...(transition ? { transition } : {}),
    });
  }

  recoverPermissions(
    input: Parameters<
      ManagedNativeSettings["recoverPermissionRegistrations"]
    >[0],
  ): Promise<void> {
    const previous = this.recovery ?? Promise.resolve();
    const attempt = previous
      .catch(() => {})
      .then(() => this.recoverPermissionRegistrations(input));
    this.recovery = attempt;
    void attempt.then(
      () => {
        if (this.recovery === attempt) this.recovery = null;
      },
      () => {
        if (this.recovery === attempt) this.recovery = null;
      },
    );
    return attempt;
  }

  private async recoverPermissionRegistrations(input: {
    binding: NativeSettingsBinding;
    readOperation(operationId: string): Promise<unknown>;
    readSettings(): Promise<NativeThreadSettings>;
    assertCurrent(): void;
  }): Promise<void> {
    if (!this.options.delivery.permissionRegistrations)
      throw new Error("Durable permission recovery is unavailable.");
    input.assertCurrent();
    const registrations = await this.options.delivery.permissionRegistrations(
      input.binding,
    );
    input.assertCurrent();
    for (const registration of registrations) {
      const { scope, transition } = registration;
      const existing = this.commands.get(scope.nativeOperationId);
      if (
        existing &&
        ((!existing.recoveryBindingId &&
          existing.scope.runtimeGeneration ===
            input.binding.runtimeGeneration &&
          (existing.phase === "registering" || existing.phase === "queued")) ||
          (existing.recoveryBindingId === input.binding.bindingId &&
            existing.recoveryComplete &&
            existing.phase === "queued"))
      )
        continue;
      const publicationScope = {
        ...scope,
        runtimeGeneration: input.binding.runtimeGeneration,
      };
      this.ensureObservation(publicationScope);
      if (this.subscription!.generation !== input.binding.runtimeGeneration)
        throw new Error("Permission recovery belongs to a replaced transport.");
      const command: NonNullable<typeof existing> = existing ?? {
        scope,
        transition,
        submissionId: null,
      };
      command.recoveryBindingId = input.binding.bindingId;
      command.publicationScope = publicationScope;
      command.applied = undefined;
      command.recoveryComplete = false;
      this.commands.set(scope.nativeOperationId, command);
      if (
        existing?.phase === "rejected" &&
        existing.rejection &&
        scope.runtimeGeneration === input.binding.runtimeGeneration
      ) {
        const current = nativeThreadSettingsSchema.parse(
          await input.readSettings(),
        );
        input.assertCurrent();
        if (current.settingsVersion?.epoch !== input.binding.nativeEpoch)
          throw new Error(
            "Permission rejection recovery belongs to another native epoch.",
          );
        await this.options.delivery.record(
          scope,
          "rejected",
          existing.rejection.submissionId,
          { rejection: existing.rejection.content, currentSettings: current },
        );
        command.recoveryComplete = true;
        continue;
      }
      let operation: unknown;
      try {
        operation = await input.readOperation(scope.nativeOperationId);
      } catch (error) {
        input.assertCurrent();
        const absence = z
          .object({
            reason: z.literal("settingsOperationNotFound"),
            threadId: z.literal(scope.threadId),
            operationId: z.literal(scope.nativeOperationId),
          })
          .strict();
        if (
          scope.runtimeGeneration !== input.binding.runtimeGeneration &&
          error instanceof CodexNativeRpcError &&
          error.requestMethod === "thread/settings/operation/read" &&
          error.nativeError.code === -32004 &&
          absence.safeParse(error.nativeError.data).success
        ) {
          await this.options.delivery.record(scope, "rejected", null, {
            reason: "native-journal-proved-operation-absent",
            nativeError: error.nativeError,
          });
          command.phase = "rejected";
          command.recoveryComplete = true;
          continue;
        }
        throw error;
      }
      const journal = z
        .object({
          threadId: z.string(),
          operationId: z.string(),
          submissionId: z.string().min(1),
          phase: z.enum(["pending", "applied", "rejected"]),
          resolvedSecurity: z.unknown(),
          threadSettings: nativeThreadSettingsSchema.nullable(),
          rejection: z.string().nullable(),
        })
        .parse(operation);
      input.assertCurrent();
      if (
        journal.threadId !== scope.threadId ||
        journal.operationId !== scope.nativeOperationId
      )
        throw new Error(
          "Native permission journal returned another operation.",
        );
      command.submissionId = journal.submissionId;
      if (journal.phase === "pending") {
        if (!command.applied) command.phase = "queued";
        await this.options.delivery.record(
          scope,
          "queued",
          journal.submissionId,
          journal,
        );
        command.recoveryComplete = true;
        continue;
      }
      if (journal.phase === "rejected") {
        command.phase = "rejected";
        command.rejection = {
          submissionId: journal.submissionId,
          content: journal,
        };
        await this.options.delivery.record(
          scope,
          "rejected",
          journal.submissionId,
          journal,
        );
        command.recoveryComplete = true;
        continue;
      }
      // Preserve historical application separately from current confirmation.
      if (!journal.threadSettings)
        throw new Error(
          "Applied native permission journal lacks its committed settings.",
        );
      const originalClaim = confirmedNativePermissionClaim({
        transition,
        settings: journal.threadSettings,
        resolvedSecurity: journal.resolvedSecurity,
      });
      if (scope.runtimeGeneration !== input.binding.runtimeGeneration) {
        await this.options.delivery.record(
          scope,
          "applied",
          journal.submissionId,
          journal,
          originalClaim,
        );
      }
      const current = nativeThreadSettingsSchema.parse(
        await input.readSettings(),
      );
      input.assertCurrent();
      let claim;
      try {
        claim = confirmedNativePermissionClaim({
          transition,
          settings: current,
          resolvedSecurity: journal.resolvedSecurity,
        });
      } catch {
        command.recoveryComplete = true;
        continue;
      } // A newer native policy does not contradict historical application.
      if (claim.settingsVersion.epoch !== input.binding.nativeEpoch)
        throw new Error(
          "Permission recovery settings belong to another native epoch.",
        );
      command.applied = current;
      command.phase = "applied";
      await this.options.delivery.record(
        scope,
        "applied",
        journal.submissionId,
        { journal, currentSettings: current },
        claim,
        input.binding.bindingId,
      );
      command.recoveryComplete = true;
    }
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
      if (command.transition) {
        let claim;
        try {
          claim = confirmedNativePermissionClaim({
            transition: command.transition,
            settings: parsed.data.threadSettings,
            resolvedSecurity: parsed.data.resolvedSecurity,
          });
        } catch (error) {
          await this.options.delivery.record(
            command.scope,
            "correlation-conflict",
            parsed.data.submissionId,
            params,
          );
          this.options.onError(error, command.scope.operationId);
          return;
        }
        command.applied = parsed.data.threadSettings;
        command.phase = "applied";
        await this.options.delivery.record(
          command.scope,
          "applied",
          parsed.data.submissionId,
          params,
          claim,
          command.recoveryBindingId,
        );
        return;
      }
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
      command.phase = "rejected";
      command.rejection = { submissionId: parsed.data.turnId, content: params };
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
    if (!command.applied) command.phase = "uncertain";
    if (!frame) {
      if (command.transition) return; // Actual operation readback settles durable permission requests.
      await this.options.delivery.record(
        command.scope,
        "transport-lost",
        command.submissionId,
        { reason: "native-response-unavailable" },
      );
    } else if ("error" in frame) {
      command.phase = "rejected";
      command.rejection = {
        submissionId: command.submissionId,
        content: frame,
      };
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
        if (!command.applied) command.phase = "queued";
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
