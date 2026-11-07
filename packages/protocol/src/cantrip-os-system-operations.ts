import { z } from "zod";
import { cantripOsDispatchScopeSchema } from "./worker-command-cantrip-os.js";
import { cantripOsTransportSchema } from "./cantrip-os.js";
import { cantripOsPackageExpectedSchema } from "./cantrip-os-packages.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import {
  cantripOsSystemCaptureAdmissionSchema,
  cantripOsSystemManifestSchema,
  cantripOsSystemArchiveReceiptSchema,
} from "./cantrip-os-system.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const cantripOsSystemScopeSchema = cantripOsDispatchScopeSchema.omit({
  runtimeGeneration: true,
});
export const cantripOsSystemTargetSchema = z
  .object({
    generation: z.uuid(),
    expected: cantripOsPackageExpectedSchema,
    containerId: digest,
    containerName: name,
    imageId: image,
    architecture: z.string().min(1).max(200).nullable(),
    identityEvidence: z.enum(["guest-identity", "retained-container"]),
  })
  .strict();
export const cantripOsSystemReferenceSchema = z
  .object({
    operationId: z.uuid(),
    scope: cantripOsSystemScopeSchema,
    targetGeneration: z.uuid(),
  })
  .strict();
export const cantripOsSystemBaseImageSchema = z
  .object({
    imageId: image,
    architecture: z.string().min(1).max(200),
    tags: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export const cantripOsSystemSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("checkpoint"),
      capture: cantripOsSystemCaptureAdmissionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("base"), imageId: image }).strict(),
]);
const operation = z
  .object({
    mode: z.enum(["execute", "observe", "continue", "prepare"]),
    operationId: z.uuid(),
    scope: cantripOsSystemScopeSchema,
    transport: cantripOsTransportSchema.options[0],
    target: cantripOsSystemTargetSchema,
  })
  .strict();
export const cantripOsSystemOperationCommandSchema = z.discriminatedUnion(
  "type",
  [
    operation
      .extend({
        type: z.literal("cantrip-os.system.capture"),
        action: z.literal("capture"),
        checkpointId: z.uuid(),
        resumeOriginal: z.boolean(),
      })
      .strict(),
    operation
      .extend({
        type: z.literal("cantrip-os.system.replace"),
        action: z.literal("replace"),
        source: cantripOsSystemSourceSchema,
        startTarget: z.boolean(),
      })
      .strict(),
    operation
      .extend({
        type: z.literal("cantrip-os.system.rollback"),
        action: z.literal("rollback"),
        replacement: cantripOsSystemReferenceSchema,
        startTarget: z.boolean(),
      })
      .strict(),
  ],
);
export const workerCantripOsSystemCommandSchemas = [
  z
    .object({
      type: z.literal("cantrip-os.system.status"),
      scope: cantripOsSystemScopeSchema,
      transport: cantripOsTransportSchema,
      target: cantripOsSystemTargetSchema.optional(),
      recovery: cantripOsSystemReferenceSchema.optional(),
    })
    .strict(),
  ...cantripOsSystemOperationCommandSchema.options,
] as const;
export const cantripOsSystemWorkerCommandSchema = z.discriminatedUnion(
  "type",
  workerCantripOsSystemCommandSchemas,
);
export const cantripOsSystemStatusResultSchema = z
  .object({
    supported: z.boolean(),
    target: cantripOsSystemTargetSchema.nullable(),
    bases: z.array(cantripOsSystemBaseImageSchema).max(256),
    running: z.boolean().nullable(),
    enrollment: z
      .object({ containerId: digest, guestInstanceId: z.uuid() })
      .strict()
      .nullable()
      .default(null),
    error: z.string().max(4000).nullable(),
  })
  .strict();
export const cantripOsSystemOperationContextSchema = cantripOsSystemScopeSchema
  .extend({
    targetGeneration: z.uuid(),
    operationId: z.uuid(),
    containerId: digest,
  })
  .strict();
export const CANTRIP_OS_SYSTEM_RESULT_BYTES = 16 * 1024 * 1024;
export const cantripOsSystemProtectedOperationResultSchema =
  encryptedPayloadEnvelopeSchema.refine(
    (value) =>
      value.ciphertext.length <=
      Math.ceil(((CANTRIP_OS_SYSTEM_RESULT_BYTES + 16) * 4) / 3),
    "Protected system outcome exceeds its byte limit",
  );
export const cantripOsSystemRootReceiptSchema = z
  .object({
    requestSha256: digest,
    originalContainerId: digest.nullable(),
    targetContainerId: digest.nullable(),
    retainedContainerId: digest.nullable(),
    runtimeHandlesRestored: z.literal(false),
    guestInstanceId: z.uuid().nullable(),
    guestAttachment: z.enum(["owned", "unattached", "unavailable"]),
  })
  .strict();
export const cantripOsSystemOperationResultSchema = z
  .object({
    operationId: z.uuid(),
    targetGeneration: z.uuid(),
    action: z.enum(["capture", "replace", "rollback"]),
    state: z.enum(["running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    protectedResult: cantripOsSystemProtectedOperationResultSchema.nullable(),
    root: cantripOsSystemRootReceiptSchema.nullable(),
    error: z.string().max(4000).nullable(),
  })
  .strict()
  .refine(
    (value) => value.state !== "ready" || value.protectedResult !== null,
    "Completed system operations require a protected outcome",
  );
export const cantripOsSystemPrivateOperationResultSchema = z
  .object({
    version: z.literal(1),
    command: cantripOsSystemOperationCommandSchema,
    capture: z
      .object({
        manifest: cantripOsSystemManifestSchema.nullable(),
        archive: cantripOsSystemArchiveReceiptSchema.nullable(),
      })
      .strict()
      .nullable(),
    replacement: z.unknown().nullable(),
    diagnostic: z.string().max(32768).nullable(),
  })
  .strict();
export type CantripOsSystemScope = z.infer<typeof cantripOsSystemScopeSchema>;
export type CantripOsSystemTarget = z.infer<typeof cantripOsSystemTargetSchema>;
export type CantripOsSystemReference = z.infer<
  typeof cantripOsSystemReferenceSchema
>;
export type CantripOsSystemOperationCommand = z.infer<
  typeof cantripOsSystemOperationCommandSchema
>;
export type CantripOsSystemWorkerCommand = z.infer<
  typeof cantripOsSystemWorkerCommandSchema
>;
export type CantripOsSystemOperationResult = z.infer<
  typeof cantripOsSystemOperationResultSchema
>;
export type CantripOsSystemOperationContext = z.infer<
  typeof cantripOsSystemOperationContextSchema
>;
export type CantripOsSystemPrivateOperationResult = z.infer<
  typeof cantripOsSystemPrivateOperationResultSchema
>;
