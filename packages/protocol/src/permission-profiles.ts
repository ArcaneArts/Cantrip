import { z } from "zod";
import { DEFAULT_PERMISSION_PROFILE_ID } from "./settings.js";

export const permissionProfileIdSchema = z.string().min(1).max(200);
export const YOLO_PERMISSION_PROFILE_ID = ":yolo" as const;

export const permissionProfileSummarySchema = z.object({
  id: permissionProfileIdSchema,
  description: z.string(),
  allowed: z.boolean(),
});

export const permissionProfileCapabilitySchema = z.object({
  available: z.boolean(),
  profiles: z.array(permissionProfileSummarySchema),
  reason: z.string().min(1).nullable(),
});

/** Public authorization metadata; the exact native settings remain encrypted. */
export const permissionTransitionSchema = z
  .object({
    selectedId: permissionProfileIdSchema.nullable(),
    resolvedSelectedId: permissionProfileIdSchema,
    effectiveId: permissionProfileIdSchema,
    expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  })
  .strict();
export type PermissionTransition = z.infer<typeof permissionTransitionSchema>;

export const chatPermissionProfileStateSchema =
  permissionProfileCapabilitySchema.extend({
    selectedId: permissionProfileIdSchema,
    effectiveId: permissionProfileIdSchema,
    defaultId: permissionProfileIdSchema.default(DEFAULT_PERMISSION_PROFILE_ID),
    usesDefault: z.boolean().default(false),
    forcedByWorktreePolicy: z.boolean(),
    policyRevision: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .default("0"),
    confirmed: z.boolean().default(false),
    transition: permissionTransitionSchema
      .extend({
        operationId: z.string().min(1),
        status: z.enum([
          "accepted",
          "dispatched",
          "applied",
          "rejected",
          "uncertain",
        ]),
      })
      .nullable()
      .default(null),
  });

export const chatPermissionProfileUpdateSchema = z.object({
  id: permissionProfileIdSchema.nullable(),
  operationId: z.string().min(1).max(255).optional(),
  bindingId: z.string().min(1).max(255).optional(),
  expectedRevision: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/u)
    .optional(),
});

export type PermissionProfileSummary = z.infer<
  typeof permissionProfileSummarySchema
>;
export type PermissionProfileCapability = z.infer<
  typeof permissionProfileCapabilitySchema
>;
export type ChatPermissionProfileState = z.infer<
  typeof chatPermissionProfileStateSchema
>;
export type ChatPermissionProfileUpdate = z.infer<
  typeof chatPermissionProfileUpdateSchema
>;
