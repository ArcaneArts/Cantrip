import { z } from "zod";
import {
  cantripOsPackageArtifactSchema,
  cantripOsPackageArtifactsSchema,
  cantripOsPackageInstalledSchema,
  cantripOsPackageProtectedResultSchema,
} from "./cantrip-os-packages.js";

/** Public management contracts contain no transport, identity locator or guest paths. */
export const cantripOsPackageTargetSummarySchema = z
  .object({
    generation: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1).max(200),
    attachmentGeneration: z.uuid(),
    architecture: z.string().min(1).max(64),
    verifiedAt: z.iso.datetime(),
  })
  .strict();
export const cantripOsPackageStatusSchema = z
  .object({
    target: cantripOsPackageTargetSummarySchema.nullable(),
    installed: z
      .array(cantripOsPackageInstalledSchema.omit({ diagnostic: true }))
      .max(4),
    available: z.array(cantripOsPackageArtifactSchema).max(256),
    unavailable: z.number().int().nonnegative(),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsPackageCreateSchema = z
  .object({
    operationId: z.uuid(),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    action: z.enum(["upgrade", "repair"]),
    configuration: z.enum(["preserve", "package-defaults"]),
    packages: cantripOsPackageArtifactsSchema,
  })
  .strict()
  .refine(
    (value) => value.action === "repair" || value.configuration === "preserve",
    "Configuration replacement requires explicit repair",
  );
export const cantripOsPackageControlSchema = z
  .object({ attachmentGeneration: z.uuid(), targetGeneration: z.uuid() })
  .strict();
export const cantripOsPackageSummarySchema = z
  .object({
    operationId: z.uuid(),
    instanceId: z.uuid(),
    workerId: z.string().min(1).max(200),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    action: z.enum(["upgrade", "repair"]),
    configuration: z.enum(["preserve", "package-defaults"]),
    packages: cantripOsPackageArtifactsSchema,
    state: z.enum(["admitted", "running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    protectedResult: cantripOsPackageProtectedResultSchema.nullable(),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsPackageListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
export const cantripOsPackagePageSchema = z
  .object({
    items: z.array(cantripOsPackageSummarySchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export type CantripOsPackageCreate = z.infer<
  typeof cantripOsPackageCreateSchema
>;
export type CantripOsPackageControl = z.infer<
  typeof cantripOsPackageControlSchema
>;
export type CantripOsPackageSummary = z.infer<
  typeof cantripOsPackageSummarySchema
>;
export type CantripOsPackageStatus = z.infer<
  typeof cantripOsPackageStatusSchema
>;
