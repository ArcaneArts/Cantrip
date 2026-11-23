import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import {
  cantripOsTransportSchema,
  cantripOsGuestPathSchema,
} from "./cantrip-os.js";
import { cantripOsDispatchScopeSchema } from "./worker-command-cantrip-os.js";
export const CANTRIP_OS_PACKAGE_PRIVATE_BYTES = 4 * 1024 * 1024;
export const cantripOsPackageProtectedResultSchema =
  encryptedPayloadEnvelopeSchema.refine(
    (value) =>
      value.ciphertext.length <=
      Math.ceil(((CANTRIP_OS_PACKAGE_PRIVATE_BYTES + 16) * 4) / 3),
    "Protected package outcome exceeds its byte limit",
  );

export const cantripOsPackageNameSchema = z.enum([
  "cantrip-os-workspaces",
  "cantrip-os-executor",
  "cantrip-os-remote",
  "cantrip-os-recovery",
]);
export const cantripOsPackageShaSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const cantripOsPackageArtifactSchema = z
  .object({
    name: cantripOsPackageNameSchema,
    version: z.string().regex(/^[A-Za-z0-9.+:~_-]{1,200}$/),
    architecture: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    sha256: cantripOsPackageShaSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 ** 3),
  })
  .strict();
export const cantripOsPackageArtifactsSchema = z
  .array(cantripOsPackageArtifactSchema)
  .min(1)
  .max(4)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.name)).size === entries.length,
    "Select each package only once",
  );
export const cantripOsPackageManifestSchema = z
  .object({
    format: z.literal("cantrip-os-package-artifact"),
    version: z.literal(1),
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*\.deb$/),
    artifact: cantripOsPackageArtifactSchema,
  })
  .strict();
export const cantripOsPackageExpectedSchema = z
  .object({
    guestInstanceId: z.uuid(),
    ownerId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
    identityPath: cantripOsGuestPathSchema,
  })
  .strict();
export const cantripOsPackageTargetSchema = z
  .object({
    generation: z.uuid(),
    expected: cantripOsPackageExpectedSchema,
    bootId: z.uuid(),
    initStart: z.string().regex(/^[0-9]{1,30}$/),
    architecture: z.string().min(1).max(64),
    containerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export const cantripOsGuestPackageRequestSchema = z
  .object({
    version: z.literal(2),
    operationId: z.uuid(),
    scopeKey: cantripOsPackageShaSchema,
    action: z.enum(["upgrade", "repair"]),
    configuration: z.enum(["preserve", "package-defaults"]),
    expected: cantripOsPackageExpectedSchema
      .extend({
        bootId: z.uuid(),
        initStart: z.string().regex(/^[0-9]{1,30}$/),
      })
      .strict(),
    packages: cantripOsPackageArtifactsSchema,
  })
  .strict()
  .refine(
    (value) => value.action === "repair" || value.configuration === "preserve",
    "Configuration replacement requires explicit repair",
  );
export const cantripOsPackageInstalledSchema = z
  .object({
    name: cantripOsPackageNameSchema,
    exitCode: z.number().int(),
    status: z.string().max(1000),
    diagnostic: z.string().max(2048),
  })
  .strict();
export const cantripOsPackageProbeSchema = z
  .object({
    version: z.literal(1),
    expected: cantripOsPackageExpectedSchema,
    bootId: z.uuid(),
    initStart: z.string().regex(/^[0-9]{1,30}$/),
    architecture: z.string().min(1).max(64),
    packages: z.array(cantripOsPackageInstalledSchema).max(4),
  })
  .strict();
const process = z
  .object({
    pid: z.number().int().positive(),
    start: z.string().min(1),
    boot: z.uuid(),
  })
  .strict()
  .nullable();
export const cantripOsGuestPackageRecordSchema = z
  .object({
    format: z.literal("cantrip-os-package-operation"),
    version: z.literal(1),
    request: cantripOsGuestPackageRequestSchema,
    requestSha256: cantripOsPackageShaSchema,
    state: z.enum(["staged", "running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    createdAt: z.number(),
    updatedAt: z.number(),
    received: z.array(cantripOsPackageShaSchema).max(4),
    process,
    installer: process,
    receipt: z.unknown().nullable(),
    error: z.string().max(16384).nullable(),
    active: z.boolean(),
    installerActive: z.boolean(),
    diagnostics: z.string().max(16384),
  })
  .passthrough();
/** Package administration survives a broken/stopped executor. Boot and init
 * identity belong to its separate verified target; no live execution epoch is
 * invented to authorize repair. */
export const cantripOsPackageScopeSchema = cantripOsDispatchScopeSchema.omit({
  runtimeGeneration: true,
});
const base = z
  .object({
    scope: cantripOsPackageScopeSchema,
    transport: cantripOsTransportSchema,
  })
  .strict();
export const cantripOsPackageOperationCommandSchema = base
  .extend({
    type: z.literal("cantrip-os.packages.operation"),
    mode: z.enum(["execute", "observe", "continue", "abandon"]),
    operationId: z.uuid(),
    target: cantripOsPackageTargetSchema,
    action: z.enum(["upgrade", "repair"]),
    configuration: z.enum(["preserve", "package-defaults"]),
    packages: cantripOsPackageArtifactsSchema,
  })
  .strict()
  .refine(
    (value) => value.action === "repair" || value.configuration === "preserve",
    "Configuration replacement requires explicit repair",
  );
export const workerCantripOsPackageCommandSchemas = [
  base
    .extend({
      type: z.literal("cantrip-os.packages.status"),
      target: cantripOsPackageTargetSchema.optional(),
    })
    .strict(),
  cantripOsPackageOperationCommandSchema,
] as const;
export const cantripOsPackageWorkerCommandSchema = z.discriminatedUnion(
  "type",
  workerCantripOsPackageCommandSchemas,
);
export const cantripOsPackageCatalogResultSchema = z
  .object({
    target: cantripOsPackageTargetSchema,
    available: z.array(cantripOsPackageArtifactSchema).max(256),
    unavailable: z.number().int().nonnegative(),
    installed: z
      .array(cantripOsPackageInstalledSchema.omit({ diagnostic: true }))
      .max(4),
  })
  .strict();
export const cantripOsPackageCryptoContextSchema = z
  .object({
    ownerId: z.string().min(1).max(200),
    serverId: z.string().min(1).max(2000),
    workerId: z.string().min(1).max(200),
    instanceId: z.uuid(),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    operationId: z.uuid(),
  })
  .strict();
export const cantripOsPackageOperationResultSchema = z
  .object({
    operationId: z.uuid(),
    targetGeneration: z.uuid(),
    action: z.enum(["upgrade", "repair"]),
    configuration: z.enum(["preserve", "package-defaults"]),
    state: z.enum(["running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    protectedResult: cantripOsPackageProtectedResultSchema.nullable(),
    error: z.string().max(4000).nullable(),
  })
  .strict()
  .refine(
    (result) => result.state !== "ready" || result.protectedResult !== null,
    "A ready installation requires its protected outcome",
  );
export const cantripOsPackagePrivateResultSchema = z
  .object({
    version: z.literal(1),
    request: cantripOsGuestPackageRequestSchema,
    record: cantripOsGuestPackageRecordSchema.nullable(),
    diagnostic: z.string().max(32768).nullable(),
  })
  .strict();
export type CantripOsPackageArtifact = z.infer<
  typeof cantripOsPackageArtifactSchema
>;
export type CantripOsPackageScope = z.infer<typeof cantripOsPackageScopeSchema>;
export type CantripOsPackageTarget = z.infer<
  typeof cantripOsPackageTargetSchema
>;
export type CantripOsPackageWorkerCommand = z.infer<
  typeof cantripOsPackageWorkerCommandSchema
>;
export type CantripOsPackageOperationCommand = z.infer<
  typeof cantripOsPackageOperationCommandSchema
>;
export type CantripOsGuestPackageRequest = z.infer<
  typeof cantripOsGuestPackageRequestSchema
>;
export type CantripOsGuestPackageRecord = z.infer<
  typeof cantripOsGuestPackageRecordSchema
>;
export type CantripOsPackagePrivateResult = z.infer<
  typeof cantripOsPackagePrivateResultSchema
>;
export type CantripOsPackageCryptoContext = z.infer<
  typeof cantripOsPackageCryptoContextSchema
>;
