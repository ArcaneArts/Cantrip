import {
  permissionTransitionSchema,
  permissionProfileIdSchema,
} from "./permission-profiles.js";
import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";

const id = z.string().min(1).max(255);
/** Native order is comparable only within one Core epoch. Decimal u64 preserves precision. */
export const nativeSettingsVersionSchema = z
  .object({
    epoch: id,
    revision: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/u)
      .refine(
        (value) =>
          /^(0|[1-9][0-9]{0,19})$/u.test(value) &&
          BigInt(value) <= 18_446_744_073_709_551_615n,
      ),
  })
  .strict();
export type NativeSettingsVersion = z.infer<typeof nativeSettingsVersionSchema>;

/** Exact source of a protected settings snapshot; this is observation, not input authority. */
export const nativeSettingsSnapshotContextSchema = z
  .object({
    chatId: id,
    workerId: id,
    threadId: id,
    runtimeGeneration: id,
    settingsVersion: nativeSettingsVersionSchema,
  })
  .strict();
export type NativeSettingsSnapshotContext = z.infer<
  typeof nativeSettingsSnapshotContextSchema
>;

/** Full native settings stay encrypted. Fingerprints are comparable only for the
 * same context and encryption key revision, never across account/key changes. */
export const protectedNativeSettingsSnapshotSchema = z
  .object({
    context: nativeSettingsSnapshotContextSchema,
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    protectedContent: encryptedPayloadEnvelopeSchema,
  })
  .strict();
export type ProtectedNativeSettingsSnapshot = z.infer<
  typeof protectedNativeSettingsSnapshotSchema
>;

/** Server-resolved placement and route for an actual read of an existing runtime. */
export const nativeSettingsReadScopeSchema = z
  .object({
    chatId: id,
    workerId: id,
    threadId: id,
    contextKind: z.enum(["project", "standalone"]),
    projectId: id.nullable(),
    placementId: id,
    modelRouteId: id.nullable(),
    providerAccountId: id.nullable(),
  })
  .strict();
export type NativeSettingsReadScope = z.infer<
  typeof nativeSettingsReadScopeSchema
>;

/** One server-issued observation binding. Replacing it does not grant native input. */
export const nativeSettingsBindingSchema = nativeSettingsReadScopeSchema
  .extend({
    bindingId: id,
    runtimeGeneration: id,
    nativeEpoch: id,
  })
  .strict();
export type NativeSettingsBinding = z.infer<typeof nativeSettingsBindingSchema>;

export const nativeSettingsIntentSchema = z
  .object({
    operationId: id,
    operationGeneration: id,
    origin: z.enum(["gui", "terminal", "autonomous"]),
    source: z
      .object({
        workerId: id,
        threadId: id.nullable(),
        runtimeGeneration: id.nullable(),
      })
      .strict(),
    permissionTransition: permissionTransitionSchema.optional(),
    // Full desired selection/patch is encrypted before publication, as with admission.
    protectedContent: encryptedPayloadEnvelopeSchema,
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type NativeSettingsIntent = z.infer<typeof nativeSettingsIntentSchema>;

const serverRevision = z.string().regex(/^(0|[1-9][0-9]*)$/u);
export const nativeSettingsPendingSchema = z
  .object({
    intent: nativeSettingsIntentSchema,
    desiredRevision: serverRevision,
    bindingId: id.nullable(),
    status: z.enum(["accepted", "dispatched", "uncertain"]),
  })
  .strict();
export type NativeSettingsPending = z.infer<typeof nativeSettingsPendingSchema>;

/** Server revision orders canonical publication; native versions order application.
 * Neither a request nor its queue acknowledgment is an effective selection. */
export const nativePermissionPolicyClaimSchema = z
  .object({
    effectiveId: permissionProfileIdSchema,
    settingsVersion: nativeSettingsVersionSchema,
  })
  .strict();
export type NativePermissionPolicyClaim = z.infer<
  typeof nativePermissionPolicyClaimSchema
>;
export const nativePermissionPolicySchema = permissionTransitionSchema
  .omit({ expectedRevision: true })
  .extend({
    revision: serverRevision,
    operationId: id,
    operationGeneration: id,
    source: nativeSettingsReadScopeSchema
      .omit({ chatId: true })
      .extend({ runtimeGeneration: id }),
    settingsVersion: nativeSettingsVersionSchema,
  })
  .strict();
export type NativePermissionPolicy = z.infer<
  typeof nativePermissionPolicySchema
>;

export const nativeSettingsStateSchema = z
  .object({
    chatId: id,
    revision: serverRevision,
    desiredRevision: serverRevision,
    desired: nativeSettingsIntentSchema.nullable(),
    desiredStatus: z
      .enum(["accepted", "dispatched", "applied", "rejected", "uncertain"])
      .nullable(),
    pending: z.array(nativeSettingsPendingSchema),
    binding: nativeSettingsBindingSchema.nullable(),
    effective: protectedNativeSettingsSnapshotSchema.nullable(),
    permissionPolicy: nativePermissionPolicySchema.nullable().default(null),
  })
  .strict();
export type NativeSettingsState = z.infer<typeof nativeSettingsStateSchema>;

export const nativeSettingsRefreshRequestSchema = z
  .object({ workerId: id, chatId: id })
  .strict();
export const nativeSettingsObservationRequestSchema = z
  .object({
    workerId: id,
    bindingId: id,
    snapshot: protectedNativeSettingsSnapshotSchema,
  })
  .strict();
export const nativeSettingsObservationReceiptSchema = z
  .object({
    bindingId: id,
    revision: serverRevision,
    settingsVersion: nativeSettingsVersionSchema,
  })
  .strict();
export type NativeSettingsObservationRequest = z.infer<
  typeof nativeSettingsObservationRequestSchema
>;
export type NativeSettingsObservationReceipt = z.infer<
  typeof nativeSettingsObservationReceiptSchema
>;
