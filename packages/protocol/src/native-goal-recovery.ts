import { z } from "zod";
import { nativeSettingsReadScopeSchema } from "./native-settings-state.js";

const id = z.string().min(1).max(255);

/** An existing native Goal cycle, never another copy of its prompt or setter. */
export const nativeGoalRecoverySourceSchema = z
  .object({
    operationId: id,
    operationGeneration: id,
    threadId: id,
    goalEpoch: id,
  })
  .strict();

export const nativeGoalRecoveryAdmissionSchema = z
  .object({
    operationId: id,
    operationGeneration: id,
    workerGeneration: z.uuid(),
  })
  .strict();

/** One bounded delivery marker on the canonical queue state. Capacity and FIFO
 * ordinals still belong exclusively to the worker's admission journal. */
export const nativeGoalRecoverySchema = z
  .object({
    source: nativeGoalRecoverySourceSchema,
    // Current configured provider, never an account/model or capacity owner.
    providerId: id.optional(),
    // A committed provider change ends the old FIFO episode. Legacy is zero.
    orderEpoch: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    admission: nativeGoalRecoveryAdmissionSchema.nullable().default(null),
  })
  .strict();

export const nativeGoalRecoveryReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      source: nativeGoalRecoverySourceSchema,
      status: z.literal("admitted"),
      admission: nativeGoalRecoveryAdmissionSchema,
    })
    .strict(),
  z
    .object({
      source: nativeGoalRecoverySourceSchema,
      status: z.literal("ineligible"),
      workerGeneration: z.uuid(),
      // A negative read may retire only this actual native binding and FIFO
      // episode. Older receipts without observation remain non-destructive.
      observation: nativeSettingsReadScopeSchema
        .extend({
          runtimeGeneration: id,
          nativeEpoch: id,
          orderEpoch: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        })
        .strict()
        .optional(),
      reason: z.enum([
        "source-changed",
        "paused",
        "stopped",
        "epoch-changed",
        "not-active",
      ]),
    })
    .strict(),
]);

export type NativeGoalRecoverySource = z.infer<
  typeof nativeGoalRecoverySourceSchema
>;
export type NativeGoalRecoveryAdmission = z.infer<
  typeof nativeGoalRecoveryAdmissionSchema
>;
export type NativeGoalRecovery = z.infer<typeof nativeGoalRecoverySchema>;
export type NativeGoalRecoveryReceipt = z.infer<
  typeof nativeGoalRecoveryReceiptSchema
>;

/** A canonical admission can survive a crash before its first journal write.
 * Only the replacement worker, after an actual keeper read, may retire it. */
export const nativeGoalRecoveryFenceSchema = z
  .object({
    serverId: id,
    workerId: id,
    workerGeneration: z.uuid(),
    source: nativeGoalRecoverySourceSchema,
    admission: nativeGoalRecoveryAdmissionSchema,
  })
  .strict();
export const nativeGoalRecoveryFenceResultSchema = z
  .object({
    recovery: nativeGoalRecoverySchema.nullable(),
  })
  .strict();
export type NativeGoalRecoveryFence = z.infer<
  typeof nativeGoalRecoveryFenceSchema
>;
