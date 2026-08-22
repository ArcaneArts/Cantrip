import { z } from "zod";

export const RUN_CONFIGURATION_DIRECTORY = ".codex/environments" as const;
export const RUN_CONFIGURATION_CANONICAL_PATH =
  `${RUN_CONFIGURATION_DIRECTORY}/environment.toml` as const;

export const runConfigurationPlatformSchema = z.enum([
  "win32",
  "darwin",
  "linux",
]);

export const runConfigurationSourceControlStateSchema = z.enum([
  "absent",
  "tracked",
  "ignored",
  "untracked",
]);

export const runConfigurationDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    configurationPath: z.string().min(1).max(512).nullable().default(null),
    field: z.string().min(1).max(512).nullable().default(null),
  })
  .strict();

const runConfigurationScriptSchema = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0, {
    message: "Run configuration scripts cannot be blank.",
  })
  .refine((value) => !value.includes("\0"), {
    message: "Run configuration scripts cannot contain NUL characters.",
  });

export const runConfigurationSetupSchema = z
  .object({
    command: runConfigurationScriptSchema,
    platform: runConfigurationPlatformSchema.nullable(),
  })
  .strict();

export const runConfigurationActionSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    name: z.string().trim().min(1).max(200),
    icon: z.string().trim().min(1).max(100),
    command: runConfigurationScriptSchema,
    platform: runConfigurationPlatformSchema.nullable(),
    configurationPath: z.string().min(1).max(512),
    sourceIndex: z.number().int().nonnegative().max(999),
  })
  .strict();

export const runConfigurationDefinitionSchema = z
  .object({
    relativePath: z.string().min(1).max(512),
    revision: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.number().int().positive().nullable(),
    name: z.string().trim().min(1).max(200).nullable(),
    sourceControlState: runConfigurationSourceControlStateSchema.exclude([
      "absent",
    ]),
    setup: runConfigurationSetupSchema.nullable(),
    actions: z.array(runConfigurationActionSchema).max(200),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationCanonicalLocationSchema = z
  .object({
    relativePath: z.literal(RUN_CONFIGURATION_CANONICAL_PATH),
    sourceControlState: runConfigurationSourceControlStateSchema,
  })
  .strict();

export const runConfigurationInspectionSchema = z
  .object({
    platform: runConfigurationPlatformSchema,
    canonical: runConfigurationCanonicalLocationSchema,
    configured: z.boolean(),
    valid: z.boolean(),
    configurations: z.array(runConfigurationDefinitionSchema).max(64),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationSelectionSchema = z
  .object({
    configuration: runConfigurationDefinitionSchema,
    action: runConfigurationActionSchema,
  })
  .strict();

export const runInstanceStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "exited",
  "failed",
  "stopping",
  "stopped",
  "lost",
]);

export const runInstanceSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
    actionId: runConfigurationActionSchema.shape.id,
    configurationRevision: runConfigurationDefinitionSchema.shape.revision,
    state: runInstanceStateSchema,
    terminalId: z.string().min(1).max(200).nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(100).nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workerRunIdentitySchema = z
  .object({
    runId: runInstanceSchema.shape.id,
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    actionId: runInstanceSchema.shape.actionId,
    configurationRevision: runInstanceSchema.shape.configurationRevision,
  })
  .strict();

export const workerRunSnapshotSchema = workerRunIdentitySchema
  .extend({
    state: runInstanceStateSchema.exclude(["queued"]),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(100).nullable(),
  })
  .strict();

export const workerRunLookupSchema = z.discriminatedUnion("found", [
  z
    .object({ found: z.literal(false), runId: runInstanceSchema.shape.id })
    .strict(),
  z.object({ found: z.literal(true), run: workerRunSnapshotSchema }).strict(),
]);

export const workerRunReconciliationSchema = z
  .array(workerRunLookupSchema)
  .max(256);

export const workerRunLogSnapshotSchema = z
  .object({
    run: workerRunSnapshotSchema,
    data: z.string().max(100_000),
    truncated: z.boolean(),
  })
  .strict();

export const runInstanceResultSchema = z
  .object({ run: runInstanceSchema })
  .strict();

export const runTerminalSurfaceStatusSchema = z.enum([
  "applied",
  "declined",
  "unsupported",
  "expired",
  "unavailable",
]);

export const runTerminalSurfaceResultSchema = z
  .object({
    status: runTerminalSurfaceStatusSchema,
    terminalId: runInstanceSchema.shape.terminalId,
  })
  .strict();

export const runStartResultSchema = z
  .object({
    run: runInstanceSchema,
    surface: runTerminalSurfaceResultSchema.default({
      status: "unavailable",
      terminalId: null,
    }),
  })
  .strict();

export const runEnvironmentSummarySchema = z
  .object({
    worktreeId: runInstanceSchema.shape.worktreeId,
    inspection: runConfigurationInspectionSchema,
    run: runInstanceSchema.nullable(),
  })
  .strict();

export const runEnvironmentRequestSchema = z
  .object({ worktreeId: runInstanceSchema.shape.worktreeId.optional() })
  .strict();

export const runStartRequestSchema = runEnvironmentRequestSchema
  .extend({
    requestId: z.string().uuid(),
    actionId: runConfigurationActionSchema.shape.id,
    configRevision: runConfigurationDefinitionSchema.shape.revision,
    focus: z.boolean().default(true),
  })
  .strict();

export const runOpenRequestSchema = runEnvironmentRequestSchema
  .extend({ focus: z.boolean().default(true) })
  .strict();

export const runLogResultSchema = z
  .object({
    run: runInstanceSchema,
    data: z.string().max(100_000),
    truncated: z.boolean(),
  })
  .strict();

export type RunConfigurationPlatform = z.infer<
  typeof runConfigurationPlatformSchema
>;
export type RunConfigurationSourceControlState = z.infer<
  typeof runConfigurationSourceControlStateSchema
>;
export type RunConfigurationDiagnostic = z.infer<
  typeof runConfigurationDiagnosticSchema
>;
export type RunConfigurationSetup = z.infer<typeof runConfigurationSetupSchema>;
export type RunConfigurationAction = z.infer<
  typeof runConfigurationActionSchema
>;
export type RunConfigurationDefinition = z.infer<
  typeof runConfigurationDefinitionSchema
>;
export type RunConfigurationInspection = z.infer<
  typeof runConfigurationInspectionSchema
>;
export type RunConfigurationSelection = z.infer<
  typeof runConfigurationSelectionSchema
>;
export type RunInstanceState = z.infer<typeof runInstanceStateSchema>;
export type RunInstance = z.infer<typeof runInstanceSchema>;
export type RunStartResult = z.infer<typeof runStartResultSchema>;
export type RunTerminalSurfaceResult = z.infer<
  typeof runTerminalSurfaceResultSchema
>;
export type RunEnvironmentSummary = z.infer<typeof runEnvironmentSummarySchema>;
export type RunStartRequest = z.infer<typeof runStartRequestSchema>;
export type RunOpenRequest = z.infer<typeof runOpenRequestSchema>;
export type WorkerRunIdentity = z.infer<typeof workerRunIdentitySchema>;
export type WorkerRunSnapshot = z.infer<typeof workerRunSnapshotSchema>;
export type WorkerRunLookup = z.infer<typeof workerRunLookupSchema>;
export type WorkerRunLogSnapshot = z.infer<typeof workerRunLogSnapshotSchema>;
