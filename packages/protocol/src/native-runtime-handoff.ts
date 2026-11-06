import { z } from "zod";
import { modelProviderAccountWireSummarySchema } from "./providers.js";
import { inferenceJournalRecordSchema } from "./inference-recovery.js";
import { nativeAutonomousAttemptSchema } from "./native-commands.js";
import { nativeGoalRecoverySourceSchema } from "./native-goal-recovery.js";
import {
  nativeSettingsBindingSchema,
  protectedNativeSettingsSnapshotSchema,
} from "./native-settings-state.js";

const id = z.string().min(1).max(255);
/** Actual native root producer fencing, distinct from an inference journal lease.
 * The source was already retired under canonical no-dispatch authority. */
export const nativeGoalRecoveryWithdrawalSchema = z
  .object({
    operationId: z.uuid(),
    source: nativeGoalRecoverySourceSchema,
    bindingId: id,
    runtimeGeneration: id,
    runnerGeneration: id,
    workerGeneration: z.uuid(),
  })
  .strict();
export type NativeGoalRecoveryWithdrawal = z.infer<
  typeof nativeGoalRecoveryWithdrawalSchema
>;
export const nativeRuntimeHandoffQueuedSourceSchema = z
  .object({
    operationId: id,
    operationGeneration: id,
    withdrawn: z.boolean(),
    // Derived from the canonical accepted command, never from the UI request.
    autonomousAttempt: nativeAutonomousAttemptSchema.optional(),
    goalRecovery: nativeGoalRecoverySourceSchema.optional(),
    goalWithdrawal: nativeGoalRecoveryWithdrawalSchema.optional(),
    // The acknowledged Goal setter is never replayed. Only its exact pending
    // first-cycle claim is carried across the canonical route binding.
    goalClaim: z
      .object({
        id,
        promptId: id,
        promptRevision: z.number().int().nonnegative(),
        operationId: id,
        operationGeneration: id,
        goalEpoch: id,
      })
      .strict()
      .optional(),
    // Standalone inputs retain per-message model choices. Only this exact
    // transferred revision inherits the explicitly selected provider route.
    retargetedPrompt: z
      .object({ id, revision: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export type NativeRuntimeHandoffQueuedSource = z.infer<
  typeof nativeRuntimeHandoffQueuedSourceSchema
>;
export const nativeRuntimeHandoffRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    bindingId: id,
    targetModelRouteId: id,
    targetProviderAccountId: id.nullable(),
  })
  .strict();
export const nativeRuntimeHandoffPreparedSchema = z
  .object({
    // The native conversation identity survives transport into another home.
    threadId: id,
    runtimeGeneration: id,
    snapshot: protectedNativeSettingsSnapshotSchema,
    // Authenticated worker claim from the same native read as snapshot. Omission
    // supports persisted legacy receipts; null explicitly selects the default.
    reasoningEffort: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();
export const nativeRuntimeHandoffStateSchema = z
  .object({
    operationId: z.string().uuid(),
    chatId: id,
    workerId: id,
    phase: z.enum([
      "preparing",
      "prepared",
      "committed",
      "completed",
      "cancelled",
    ]),
    // Immutable reservation identity, including the original begin binding.
    cancelRequested: z.boolean().default(false),
    source: nativeSettingsBindingSchema,
    // A reservation is not no-start proof. Only the owning worker may confirm
    // withdrawal, after sealing this exact canonical source.
    queuedSource: nativeRuntimeHandoffQueuedSourceSchema.nullable().optional(),
    // Current canonical binding while recovery replaces a native incarnation.
    binding: nativeSettingsBindingSchema.nullable().default(null),
    retiredRuntimeGenerations: z.array(id).default([]),
    retiredNativeEpochs: z
      .array(z.object({ runtimeGeneration: id, nativeEpoch: id }).strict())
      .default([]),
    targetModelRouteId: id,
    targetProviderAccountId: id.nullable(),
    prepared: nativeRuntimeHandoffPreparedSchema.nullable(),
    // Public diagnostics use a code; native/provider responses remain private.
    errorCode: id.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type NativeRuntimeHandoffRequest = z.infer<
  typeof nativeRuntimeHandoffRequestSchema
>;
export type NativeRuntimeHandoffPrepared = z.infer<
  typeof nativeRuntimeHandoffPreparedSchema
>;
export type NativeRuntimeHandoffState = z.infer<
  typeof nativeRuntimeHandoffStateSchema
>;

export const nativeRuntimeHandoffInventorySchema = z.object({
  chatId: id,
  binding: nativeSettingsBindingSchema.nullable(),
  latest: nativeRuntimeHandoffStateSchema.nullable(),
  providers: z.array(
    z.object({
      id,
      name: z.string(),
      accounts: z.array(modelProviderAccountWireSummarySchema),
      requiresAccount: z.boolean(),
      models: z.array(
        z.object({ routeId: id, name: z.string(), profileName: z.string() }),
      ),
    }),
  ),
});
export type NativeRuntimeHandoffInventory = z.infer<
  typeof nativeRuntimeHandoffInventorySchema
>;

const workerOperation = z.object({
  workerId: id,
  chatId: id,
  operationId: z.string().uuid(),
});
export const nativeRuntimeHandoffWorkerRequestSchema = z.discriminatedUnion(
  "action",
  [
    workerOperation.extend({ action: z.literal("read") }).strict(),
    workerOperation
      .extend({
        action: z.literal("goal-recovery-withdrawn"),
        receipt: nativeGoalRecoveryWithdrawalSchema,
      })
      .strict(),
    workerOperation
      .extend({
        action: z.literal("withdrawn"),
        // Null can only reuse an already persisted, exact no-start deferral.
        record: inferenceJournalRecordSchema.nullable(),
      })
      .strict(),
    workerOperation
      .extend({ action: z.literal("decline-queued-source") })
      .strict(),
    workerOperation
      .extend({
        action: z.literal("prepared"),
        prepared: nativeRuntimeHandoffPreparedSchema,
        // A restarted destination may replace its receipt before commit only by
        // comparing the generation the server currently owns.
        expectedPreparedRuntimeGeneration: id.nullable(),
        expectedPreparedNativeEpoch: id.nullable().optional(),
      })
      .strict(),
    workerOperation
      .extend({
        action: z.literal("recover"),
        side: z.enum(["source", "destination"]),
        expectedBindingId: id,
        recovered: nativeRuntimeHandoffPreparedSchema,
      })
      .strict(),
    workerOperation.extend({ action: z.literal("commit") }).strict(),
    workerOperation
      .extend({
        action: z.literal("finish"),
        outcome: z.enum(["completed", "cancelled"]),
      })
      .strict(),
    workerOperation
      .extend({
        action: z.literal("failure"),
        errorCode: z.string().regex(/^[a-z0-9-]{1,100}$/),
      })
      .strict(),
  ],
);
export type NativeRuntimeHandoffWorkerRequest = z.infer<
  typeof nativeRuntimeHandoffWorkerRequestSchema
>;
