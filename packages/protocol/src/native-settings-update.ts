import { permissionTransitionSchema } from "./permission-profiles.js";
import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { nativeSettingsBindingSchema } from "./native-settings-state.js";

const id = z.string().min(1).max(255);

/** Explicit fields only. Native validation and managed permission policy remain
 * authoritative; omitted fields are never filled from a stale GUI selection. */
export const nativeSettingsPatchSchema = z
  .object({
    cwd: z.string().nullable().optional(),
    approvalPolicy: z
      .union([z.string(), z.record(z.string(), z.json())])
      .nullable()
      .optional(),
    approvalsReviewer: z.string().nullable().optional(),
    sandboxPolicy: z.record(z.string(), z.json()).nullable().optional(),
    permissions: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    // Null explicitly selects standard service; omission preserves the selection.
    serviceTier: z.string().nullable().optional(),
    // True removes the selected override, leaving the tier unspecified.
    unsetServiceTier: z.boolean().optional(),
    collaborationMode: z
      .object({
        mode: z.enum(["default", "plan"]),
        settings: z
          .object({
            model: z.string(),
            reasoning_effort: z.string().nullable(),
            developer_instructions: z.string().nullable(),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .optional(),
    // Mode-only update preserves current model/effort at native application.
    collaborationModeKind: z.enum(["default", "plan"]).optional(),
    multiAgentEnabled: z.boolean().optional(),
    subagentModel: z.string().nullable().optional(),
    subagentReasoningEffort: z.string().nullable().optional(),
    multiAgentMode: z.string().nullable().optional(),
    personality: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (patch.unsetServiceTier === true && patch.serviceTier !== undefined)
      context.addIssue({
        code: "custom",
        path: ["unsetServiceTier"],
        message: "unsetServiceTier cannot be combined with serviceTier.",
      });
  });
export type NativeSettingsPatch = z.infer<typeof nativeSettingsPatchSchema>;

/** One stable operation identity and one bound source travel with the encrypted
 * patch. Retrying transport does not authorize replaying native effects. */
export const nativeSettingsUpdateRequestSchema = z
  .object({
    operationId: id,
    bindingId: id,
    protectedPatch: encryptedPayloadEnvelopeSchema,
  })
  .strict();
export type NativeSettingsUpdateRequest = z.infer<
  typeof nativeSettingsUpdateRequestSchema
>;

export const nativeSettingsUpdateContextSchema = z
  .object({
    chatId: id,
    operationId: id,
    bindingId: id,
  })
  .strict();
export type NativeSettingsUpdateContext = z.infer<
  typeof nativeSettingsUpdateContextSchema
>;

export const nativeSettingsUpdateCommandSchema =
  nativeSettingsUpdateRequestSchema
    .extend({
      type: z.literal("chat.settings.update"),
      binding: nativeSettingsBindingSchema,
    })
    .strict();

export const nativeSettingsUpdateReceiptSchema = z
  .object({
    operationId: id,
    submissionId: id.nullable(),
    status: z.enum([
      "requesting",
      "queued",
      "applied",
      "rejected",
      "uncertain",
    ]),
  })
  .strict();
export type NativeSettingsUpdateReceipt = z.infer<
  typeof nativeSettingsUpdateReceiptSchema
>;

export const nativePermissionUpdateCommandSchema = z
  .object({
    type: z.literal("chat.permissions.update"),
    operationId: id,
    binding: nativeSettingsBindingSchema,
    permissionTransition: permissionTransitionSchema,
  })
  .strict();
export type NativePermissionUpdateCommand = z.infer<
  typeof nativePermissionUpdateCommandSchema
>;
