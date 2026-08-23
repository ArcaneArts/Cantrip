import { z } from "zod";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";

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
    platform: runConfigurationPlatformSchema.nullable(),
  })
  .strict();

export const runConfigurationActionSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    name: z.string().trim().min(1).max(200),
    icon: z.string().trim().min(1).max(100),
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

export const runConfigurationInspectionMetadataSchema = z
  .object({
    platform: runConfigurationPlatformSchema,
    configured: z.boolean(),
    valid: z.boolean(),
    hasSetup: z.boolean(),
    configurationRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
  })
  .strict();

export const protectedRunConfigurationInspectionSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    metadata: runConfigurationInspectionMetadataSchema,
    protectedInspection: endpointContentOpaqueSchema,
  })
  .strict();

export const runConfigurationSelectionSchema = z
  .object({
    configuration: runConfigurationDefinitionSchema,
    action: runConfigurationActionSchema,
  })
  .strict();

export const runConfigurationAuthoringSetupSchema = z
  .object({
    default: runConfigurationScriptSchema.nullable(),
    win32: runConfigurationScriptSchema.nullable(),
    darwin: runConfigurationScriptSchema.nullable(),
    linux: runConfigurationScriptSchema.nullable(),
  })
  .strict();

export const runConfigurationAuthoringActionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    icon: z.string().trim().min(1).max(100),
    command: runConfigurationScriptSchema,
    platform: runConfigurationPlatformSchema.nullable(),
  })
  .strict();

export const runConfigurationActionAddInputSchema = z
  .object({
    name: runConfigurationAuthoringActionSchema.shape.name,
    command: runConfigurationAuthoringActionSchema.shape.command,
    icon: runConfigurationAuthoringActionSchema.shape.icon.default("run"),
    platform: runConfigurationPlatformSchema.nullable().default(null),
    environmentName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const runConfigurationAuthoringDocumentSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(200),
    setup: runConfigurationAuthoringSetupSchema,
    actions: z.array(runConfigurationAuthoringActionSchema).max(200),
  })
  .strict()
  .superRefine((document, context) => {
    const characters =
      document.name.length +
      Object.values(document.setup).reduce(
        (total, command) => total + (command?.length ?? 0),
        0,
      ) +
      document.actions.reduce(
        (total, action) =>
          total +
          action.name.length +
          action.icon.length +
          action.command.length,
        0,
      );
    if (characters <= 500_000) return;
    context.addIssue({
      code: "custom",
      message:
        "Run configuration authoring data cannot exceed 500,000 characters.",
    });
  });

export const RUN_CONFIGURATION_AUTHORING_EXAMPLE =
  runConfigurationAuthoringDocumentSchema.parse({
    version: 1,
    name: "Project environment",
    setup: { default: null, win32: null, darwin: null, linux: null },
    actions: [
      {
        name: "Run app",
        icon: "run",
        command: "pnpm run dev",
        platform: null,
      },
    ],
  });

export const RUN_CONFIGURATION_AUTHORING_EXAMPLE_TOML = `version = 1
name = "Project environment"

[[actions]]
name = "Run app"
icon = "run"
command = "pnpm run dev"
`;

export const runConfigurationAuthoringHelpSchema = z
  .object({
    schema: z.record(z.string(), z.unknown()),
    example: runConfigurationAuthoringDocumentSchema,
    exampleToml: z.string().min(1).max(100_000),
  })
  .strict();

export const runConfigurationAuthoringSnapshotSchema = z
  .object({
    relativePath: z.literal(RUN_CONFIGURATION_CANONICAL_PATH),
    sourceControlState: runConfigurationSourceControlStateSchema,
    revision: runConfigurationDefinitionSchema.shape.revision.nullable(),
    document: runConfigurationAuthoringDocumentSchema.nullable(),
    editingError: z.string().trim().min(1).max(1_000).nullable(),
    inspection: runConfigurationInspectionSchema,
  })
  .strict();

export const protectedRunConfigurationAuthoringSnapshotSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    protectedSnapshot: endpointContentOpaqueSchema,
  })
  .strict();

export const runConfigurationWriteRequestSchema = z
  .object({
    expectedRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
    document: runConfigurationAuthoringDocumentSchema,
  })
  .strict();

export const protectedRunConfigurationWriteRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    protectedRequest: endpointContentOpaqueSchema,
  })
  .strict();

export const protectedRunConfigurationWriteResultSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    protectedResponse: endpointContentOpaqueSchema,
  })
  .strict();

export const workerRunConfigurationWriteResultSchema = z.discriminatedUnion(
  "written",
  [
    z
      .object({
        written: z.literal(false),
        reason: z.literal("revision-mismatch"),
        snapshot: runConfigurationAuthoringSnapshotSchema,
      })
      .strict(),
    z
      .object({
        written: z.literal(true),
        snapshot: runConfigurationAuthoringSnapshotSchema,
      })
      .strict(),
  ],
);

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

export const runLogContentSchema = workerRunLogSnapshotSchema
  .pick({ data: true, truncated: true })
  .strict();

export const protectedWorkerRunLogSnapshotSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    run: workerRunSnapshotSchema,
    protectedLog: endpointContentOpaqueSchema,
  })
  .strict();

export const protectedRunLogResultSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    run: runInstanceSchema,
    protectedLog: endpointContentOpaqueSchema,
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

export const worktreeSetupJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "stale",
]);

export const worktreeSetupJobErrorSchema = z
  .object({
    code: z.enum([
      "configuration-invalid",
      "configuration-stale",
      "worker-offline",
      "capability-missing",
      "setup-start-failed",
      "setup-failed",
      "setup-interrupted",
    ]),
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean(),
  })
  .strict();

export const worktreeSetupJobSummarySchema = z
  .object({
    id: z.string().uuid(),
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    workerId: runInstanceSchema.shape.workerId,
    configurationRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
    state: worktreeSetupJobStateSchema,
    stateRevision: z.number().int().positive().safe(),
    attempt: z.number().int().nonnegative().safe(),
    error: worktreeSetupJobErrorSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const workerRunSetupStatusSchema = z
  .object({
    jobId: worktreeSetupJobSummarySchema.shape.id,
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    configurationRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
    attempt: z.number().int().positive().safe(),
    state: z.enum(["running", "succeeded", "failed"]),
    output: z.string().max(100_000),
    outputTruncated: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(100).nullable(),
    error: worktreeSetupJobErrorSchema.nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workerRunSetupPublicStatusSchema = workerRunSetupStatusSchema
  .omit({ output: true, outputTruncated: true, signal: true, error: true })
  .extend({
    error: worktreeSetupJobErrorSchema
      .pick({ code: true, retryable: true })
      .strict()
      .nullable(),
  })
  .strict();

export const runSetupDetailContentSchema = z
  .object({
    output: workerRunSetupStatusSchema.shape.output,
    outputTruncated: workerRunSetupStatusSchema.shape.outputTruncated,
    signal: workerRunSetupStatusSchema.shape.signal,
    errorMessage: worktreeSetupJobErrorSchema.shape.message.nullable(),
  })
  .strict();

export const protectedWorkerRunSetupStatusSchema = z
  .object({
    operationId: z.string().uuid(),
    status: workerRunSetupPublicStatusSchema,
    protectedDetails: endpointContentOpaqueSchema,
  })
  .strict();

export const workerRunSetupLookupSchema = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(false),
      jobId: worktreeSetupJobSummarySchema.shape.id,
    })
    .strict(),
  z
    .object({ found: z.literal(true), status: workerRunSetupStatusSchema })
    .strict(),
]);

export const protectedWorkerRunSetupLookupSchema = z.discriminatedUnion(
  "found",
  [
    z
      .object({
        found: z.literal(false),
        operationId: z.string().uuid(),
        jobId: worktreeSetupJobSummarySchema.shape.id,
      })
      .strict(),
    z
      .object({
        found: z.literal(true),
        operationId: z.string().uuid(),
        status: workerRunSetupPublicStatusSchema,
        protectedDetails: endpointContentOpaqueSchema,
      })
      .strict(),
  ],
);

export const runSetupStatusResultSchema = z
  .object({
    worktreeId: runInstanceSchema.shape.worktreeId,
    setup: worktreeSetupJobSummarySchema.nullable(),
    currentConfigurationRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
    output: z.string().max(100_000).nullable(),
    outputTruncated: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(100).nullable(),
    workerStatusAvailable: z.boolean(),
  })
  .strict();

export const protectedRunSetupStatusResultSchema = z
  .object({
    operationId: z.string().uuid(),
    projectId: runInstanceSchema.shape.projectId,
    worktreeId: runInstanceSchema.shape.worktreeId,
    setup: worktreeSetupJobSummarySchema.nullable(),
    currentConfigurationRevision:
      runConfigurationDefinitionSchema.shape.revision.nullable(),
    publicWorkerStatus: workerRunSetupPublicStatusSchema.nullable(),
    protectedDetails: endpointContentOpaqueSchema.nullable(),
    workerStatusAvailable: z.boolean(),
  })
  .strict();

export const runEnvironmentSummarySchema = z
  .object({
    worktreeId: runInstanceSchema.shape.worktreeId,
    inspection: runConfigurationInspectionSchema,
    setup: worktreeSetupJobSummarySchema.nullable(),
    run: runInstanceSchema.nullable(),
  })
  .strict();

export const protectedRunEnvironmentSummarySchema = z
  .object({
    worktreeId: runInstanceSchema.shape.worktreeId,
    inspection: protectedRunConfigurationInspectionSchema,
    setup: worktreeSetupJobSummarySchema.nullable(),
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
export type RunConfigurationInspectionMetadata = z.infer<
  typeof runConfigurationInspectionMetadataSchema
>;
export type ProtectedRunConfigurationInspection = z.infer<
  typeof protectedRunConfigurationInspectionSchema
>;
export type RunConfigurationSelection = z.infer<
  typeof runConfigurationSelectionSchema
>;
export type RunConfigurationAuthoringSetup = z.infer<
  typeof runConfigurationAuthoringSetupSchema
>;
export type RunConfigurationAuthoringAction = z.infer<
  typeof runConfigurationAuthoringActionSchema
>;
export type RunConfigurationActionAddInput = z.infer<
  typeof runConfigurationActionAddInputSchema
>;
export type RunConfigurationAuthoringDocument = z.infer<
  typeof runConfigurationAuthoringDocumentSchema
>;
export type RunConfigurationAuthoringSnapshot = z.infer<
  typeof runConfigurationAuthoringSnapshotSchema
>;
export type ProtectedRunConfigurationAuthoringSnapshot = z.infer<
  typeof protectedRunConfigurationAuthoringSnapshotSchema
>;
export type RunConfigurationWriteRequest = z.infer<
  typeof runConfigurationWriteRequestSchema
>;
export type ProtectedRunConfigurationWriteRequest = z.infer<
  typeof protectedRunConfigurationWriteRequestSchema
>;
export type WorkerRunConfigurationWriteResult = z.infer<
  typeof workerRunConfigurationWriteResultSchema
>;
export type RunInstanceState = z.infer<typeof runInstanceStateSchema>;
export type RunInstance = z.infer<typeof runInstanceSchema>;
export type RunStartResult = z.infer<typeof runStartResultSchema>;
export type RunTerminalSurfaceResult = z.infer<
  typeof runTerminalSurfaceResultSchema
>;
export type RunEnvironmentSummary = z.infer<typeof runEnvironmentSummarySchema>;
export type ProtectedRunEnvironmentSummary = z.infer<
  typeof protectedRunEnvironmentSummarySchema
>;
export type RunStartRequest = z.infer<typeof runStartRequestSchema>;
export type RunOpenRequest = z.infer<typeof runOpenRequestSchema>;
export type WorktreeSetupJobState = z.infer<typeof worktreeSetupJobStateSchema>;
export type WorktreeSetupJobError = z.infer<typeof worktreeSetupJobErrorSchema>;
export type WorktreeSetupJobSummary = z.infer<
  typeof worktreeSetupJobSummarySchema
>;
export type WorkerRunSetupStatus = z.infer<typeof workerRunSetupStatusSchema>;
export type WorkerRunSetupPublicStatus = z.infer<
  typeof workerRunSetupPublicStatusSchema
>;
export type WorkerRunSetupLookup = z.infer<typeof workerRunSetupLookupSchema>;
export type RunSetupStatusResult = z.infer<typeof runSetupStatusResultSchema>;
export type WorkerRunIdentity = z.infer<typeof workerRunIdentitySchema>;
export type WorkerRunSnapshot = z.infer<typeof workerRunSnapshotSchema>;
export type WorkerRunLookup = z.infer<typeof workerRunLookupSchema>;
export type WorkerRunLogSnapshot = z.infer<typeof workerRunLogSnapshotSchema>;
