import { z } from "zod";
import {
  nativeSettingsBindingSchema,
  protectedNativeSettingsSnapshotSchema,
} from "./native-settings-state.js";

const id = z.string().min(1).max(255);
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
