import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { nativeSettingsBindingSchema } from "./native-settings-state.js";

/** Native account config defaults, deliberately separate from thread settings.
 * Null removes a user-layer override; omission leaves that key unchanged. */
export const nativeAccountDefaultsValuesSchema = z
  .object({
    model: z.string().min(1).nullable().optional(),
    model_reasoning_effort: z.string().min(1).nullable().optional(),
    service_tier: z.string().min(1).nullable().optional(),
    personality: z.string().min(1).nullable().optional(),
  })
  .strict();
export type NativeAccountDefaultsValues = z.infer<
  typeof nativeAccountDefaultsValuesSchema
>;

export const nativeAccountDefaultsWriteSchema = z
  .object({
    expectedVersion: z.string().min(1),
    values: nativeAccountDefaultsValuesSchema.refine(
      (values) => Object.values(values).some((value) => value !== undefined),
      "Select at least one account default.",
    ),
  })
  .strict();
export type NativeAccountDefaultsWrite = z.infer<
  typeof nativeAccountDefaultsWriteSchema
>;

export const nativeAccountDefaultsSnapshotSchema = z
  .object({
    version: z.string().min(1),
    stored: nativeAccountDefaultsValuesSchema,
    effective: nativeAccountDefaultsValuesSchema,
  })
  .strict();
export type NativeAccountDefaultsSnapshot = z.infer<
  typeof nativeAccountDefaultsSnapshotSchema
>;

export const nativeAccountDefaultsResultSchema = z
  .object({
    snapshot: nativeAccountDefaultsSnapshotSchema.nullable(),
    write: z
      .object({
        status: z.enum(["ok", "okOverridden"]),
        version: z.string().min(1),
      })
      .strict()
      .nullable(),
    // A confirmed write and a failed subsequent read must never be described as
    // an unexecuted write or automatically replayed.
    verification: z.enum([
      "read",
      "confirmed",
      "changed",
      "unavailable",
      "rejected",
    ]),
  })
  .strict()
  .superRefine((result, context) => {
    const valid =
      result.verification === "read"
        ? result.snapshot !== null && result.write === null
        : result.verification === "rejected"
          ? result.snapshot === null && result.write === null
          : result.verification === "unavailable"
            ? result.snapshot === null && result.write !== null
            : result.snapshot !== null &&
              result.write !== null &&
              (result.snapshot.version === result.write.version) ===
                (result.verification === "confirmed");
    if (!valid)
      context.addIssue({
        code: "custom",
        message:
          "Defaults verification must match native write and readback evidence.",
      });
  });
export type NativeAccountDefaultsResult = z.infer<
  typeof nativeAccountDefaultsResultSchema
>;

const id = z.string().min(1).max(255);
export const nativeAccountDefaultsContextSchema = z
  .object({
    chatId: id,
    bindingId: id,
    operationId: id,
    direction: z.enum(["request", "response"]),
  })
  .strict();
export type NativeAccountDefaultsContext = z.infer<
  typeof nativeAccountDefaultsContextSchema
>;
export const nativeAccountDefaultsRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({ action: z.literal("read"), bindingId: id, operationId: id })
      .strict(),
    z
      .object({
        action: z.literal("write"),
        bindingId: id,
        operationId: id,
        protectedWrite: encryptedPayloadEnvelopeSchema,
      })
      .strict(),
  ],
);
export type NativeAccountDefaultsRequest = z.infer<
  typeof nativeAccountDefaultsRequestSchema
>;
export const nativeAccountDefaultsCommandSchema = z
  .object({
    type: z.literal("chat.account-defaults"),
    binding: nativeSettingsBindingSchema,
    request: nativeAccountDefaultsRequestSchema,
  })
  .strict();
export type NativeAccountDefaultsCommand = z.infer<
  typeof nativeAccountDefaultsCommandSchema
>;
export const nativeAccountDefaultsResponseSchema = z
  .object({
    operationId: id,
    bindingId: id,
    protectedResult: encryptedPayloadEnvelopeSchema,
  })
  .strict();
export type NativeAccountDefaultsResponse = z.infer<
  typeof nativeAccountDefaultsResponseSchema
>;
