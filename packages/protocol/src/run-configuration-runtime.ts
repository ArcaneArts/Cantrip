import { z } from "zod";

import {
  runConfigurationIdSchema,
  runConfigurationRevisionSchema,
} from "./run-configuration-definitions.js";
import { runConfigurationOperationIdSchema } from "./run-configuration-operations.js";
import { endpointContentOpaqueSchema } from "./endpoint-content.js";

export const RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT = 100_000;
export const RUN_CONFIGURATION_RUNTIME_LIST_LIMIT = 256;
export const RUN_CONFIGURATION_RUNTIME_PATH_LIMIT = 8_192;

export const runConfigurationRuntimeStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "restarting",
  "stopping",
  "exited",
  "failed",
  "lost",
]);

export const runConfigurationRuntimeActiveStateSchema = z.enum([
  "starting",
  "running",
  "restarting",
  "stopping",
]);

export const runConfigurationRuntimeOperationSchema = z.enum([
  "start",
  "restart",
  "stop",
]);

export const runConfigurationRuntimeOperationOutcomeSchema = z.enum([
  "accepted",
  "already-active",
  "already-stopping",
  "not-active",
]);

export const runConfigurationRuntimeFailurePhaseSchema = z.enum([
  "definition",
  "target",
  "provider",
  "environment",
  "before-launch",
  "terminal",
  "spawn",
  "stop",
  "reconcile",
]);

export const runConfigurationRuntimeFailureSchema = z
  .object({
    phase: runConfigurationRuntimeFailurePhaseSchema,
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();

export const runConfigurationRuntimeIdentitySchema = z
  .object({
    projectId: z.string().uuid(),
    configurationId: runConfigurationIdSchema,
    worktreeId: z.string().uuid(),
  })
  .strict();

export const runConfigurationRuntimeSchema = z
  .object({
    id: z.string().uuid(),
    ...runConfigurationRuntimeIdentitySchema.shape,
    workerId: z.string().trim().min(1).max(200),
    terminalId: z.string().uuid().nullable(),
    definitionRevision: runConfigurationRevisionSchema,
    codexEnvironmentRevision: runConfigurationRevisionSchema.nullable(),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestedOperationId: runConfigurationOperationIdSchema,
    state: runConfigurationRuntimeStateSchema,
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(100).nullable(),
    failure: runConfigurationRuntimeFailureSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const runConfigurationLifecycleRequestFields = {
  operationId: runConfigurationOperationIdSchema,
  projectId: runConfigurationRuntimeIdentitySchema.shape.projectId,
  configurationId: runConfigurationRuntimeIdentitySchema.shape.configurationId,
  targetWorktreeId:
    runConfigurationRuntimeIdentitySchema.shape.worktreeId.nullable(),
};

export const runConfigurationRuntimeLifecycleRequestSchema =
  z.discriminatedUnion("operation", [
    z
      .object({
        operation: z.literal("start"),
        ...runConfigurationLifecycleRequestFields,
      })
      .strict(),
    z
      .object({
        operation: z.literal("restart"),
        ...runConfigurationLifecycleRequestFields,
      })
      .strict(),
    z
      .object({
        operation: z.literal("stop"),
        ...runConfigurationLifecycleRequestFields,
      })
      .strict(),
  ]);

export const runConfigurationRuntimeStatusQuerySchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    projectId: runConfigurationRuntimeIdentitySchema.shape.projectId,
    configurationId:
      runConfigurationRuntimeIdentitySchema.shape.configurationId.nullable(),
    targetWorktreeId:
      runConfigurationRuntimeIdentitySchema.shape.worktreeId.nullable(),
    limit: z
      .number()
      .int()
      .positive()
      .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT)
      .default(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
  })
  .strict();

export const runConfigurationRuntimeOutputQuerySchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    ...runConfigurationRuntimeIdentitySchema.shape,
    tail: z
      .number()
      .int()
      .positive()
      .max(RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT)
      .default(10_000),
  })
  .strict();

export const runConfigurationRuntimeOperationRecordSchema = z
  .object({
    id: runConfigurationOperationIdSchema,
    ...runConfigurationRuntimeIdentitySchema.shape,
    runtimeId: runConfigurationRuntimeSchema.shape.id.nullable(),
    workerId: runConfigurationRuntimeSchema.shape.workerId,
    operation: runConfigurationRuntimeOperationSchema,
    outcome: runConfigurationRuntimeOperationOutcomeSchema,
    generation: runConfigurationRuntimeSchema.shape.generation,
    definitionRevision: runConfigurationRevisionSchema.nullable(),
    codexEnvironmentRevision: runConfigurationRevisionSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const runConfigurationRuntimeOperationResultSchema = z
  .object({
    operation: runConfigurationRuntimeOperationRecordSchema,
    replayed: z.boolean(),
    runtime: runConfigurationRuntimeSchema.nullable(),
  })
  .strict();

export const runConfigurationRuntimeStatusResultSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    projectId: runConfigurationRuntimeIdentitySchema.shape.projectId,
    runtimes: z
      .array(runConfigurationRuntimeSchema)
      .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
  })
  .strict();

export const runConfigurationRuntimeOutputSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    ...runConfigurationRuntimeIdentitySchema.shape,
    generation: runConfigurationRuntimeSchema.shape.generation,
    data: z.string().max(RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT),
    truncated: z.boolean(),
  })
  .strict();

export const runConfigurationRuntimeWorkerIdentitySchema = z
  .object({
    runtimeId: runConfigurationRuntimeSchema.shape.id,
    ...runConfigurationRuntimeIdentitySchema.shape,
    workerId: runConfigurationRuntimeSchema.shape.workerId,
    definitionRevision: runConfigurationRevisionSchema,
    codexEnvironmentRevision: runConfigurationRevisionSchema.nullable(),
    generation: runConfigurationRuntimeSchema.shape.generation,
    operationId: runConfigurationOperationIdSchema,
    terminalId: runConfigurationRuntimeSchema.shape.terminalId,
  })
  .strict();

export const runConfigurationRuntimeLaunchIdentitySchema =
  runConfigurationRuntimeWorkerIdentitySchema.extend({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    terminalId: z.string().uuid(),
  });

export const runConfigurationRuntimeRootKindSchema = z.enum([
  "git-root",
  "folder-root",
]);

const runConfigurationRuntimeWorkerTargetFields = {
  identity: runConfigurationRuntimeLaunchIdentitySchema,
  rootKind: runConfigurationRuntimeRootKindSchema,
  sourcePath: z.string().min(1).max(RUN_CONFIGURATION_RUNTIME_PATH_LIMIT),
  targetPath: z.string().min(1).max(RUN_CONFIGURATION_RUNTIME_PATH_LIMIT),
};

export const runConfigurationRuntimeStartWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.start"),
    ...runConfigurationRuntimeWorkerTargetFields,
  })
  .strict();

export const runConfigurationRuntimeRestartWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.restart"),
    ...runConfigurationRuntimeWorkerTargetFields,
  })
  .strict();

export const runConfigurationRuntimeStopWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.stop"),
    identity: runConfigurationRuntimeLaunchIdentitySchema,
  })
  .strict();

export const runConfigurationRuntimeStatusWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.status"),
    identity: runConfigurationRuntimeWorkerIdentitySchema,
  })
  .strict();

export const runConfigurationRuntimeOutputWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.output"),
    requestOperationId: runConfigurationOperationIdSchema,
    serverId: z.string().trim().min(1).max(2_000),
    identity: runConfigurationRuntimeWorkerIdentitySchema,
    tail: z
      .number()
      .int()
      .positive()
      .max(RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT),
  })
  .strict();

export const runConfigurationRuntimeReconcileWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.reconcile"),
    identities: z
      .array(runConfigurationRuntimeWorkerIdentitySchema)
      .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
  })
  .strict();

export const runConfigurationRuntimeWorkerCommandSchema = z.discriminatedUnion(
  "type",
  [
    runConfigurationRuntimeStartWorkerCommandSchema,
    runConfigurationRuntimeRestartWorkerCommandSchema,
    runConfigurationRuntimeStopWorkerCommandSchema,
    runConfigurationRuntimeStatusWorkerCommandSchema,
    runConfigurationRuntimeOutputWorkerCommandSchema,
    runConfigurationRuntimeReconcileWorkerCommandSchema,
  ],
);

const workerTerminalStates = new Set(["idle", "exited", "failed", "lost"]);

export const runConfigurationRuntimeWorkerObservationSchema = z
  .object({
    ...runConfigurationRuntimeWorkerIdentitySchema.shape,
    state: runConfigurationRuntimeStateSchema,
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(100).nullable(),
    failure: runConfigurationRuntimeFailureSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    const terminal = workerTerminalStates.has(observation.state);
    if (terminal && observation.endedAt === null) {
      context.addIssue({
        code: "custom",
        message: "A terminal runtime observation requires an end time.",
        path: ["endedAt"],
      });
    }
    if (!terminal && observation.endedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "An active runtime observation cannot have an end time.",
        path: ["endedAt"],
      });
    }
    if (
      observation.failure !== null &&
      observation.state !== "failed" &&
      observation.state !== "lost"
    ) {
      context.addIssue({
        code: "custom",
        message: "Only failed or lost runtimes may include failure metadata.",
        path: ["failure"],
      });
    }
    if (
      observation.exitCode !== null &&
      observation.state !== "idle" &&
      observation.state !== "exited" &&
      observation.state !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "An active or lost runtime cannot include an exit code.",
        path: ["exitCode"],
      });
    }
  });

export const runConfigurationRuntimeWorkerOperationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed", "stale", "not-found"]),
    observation: runConfigurationRuntimeWorkerObservationSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "not-found" && result.observation !== null) {
      context.addIssue({
        code: "custom",
        message: "A missing runtime cannot include an observation.",
        path: ["observation"],
      });
    }
    if (result.outcome !== "not-found" && result.observation === null) {
      context.addIssue({
        code: "custom",
        message: "A runtime operation result requires an observation.",
        path: ["observation"],
      });
    }
  });

export const runConfigurationRuntimeWorkerLookupSchema = z.discriminatedUnion(
  "found",
  [
    z
      .object({
        found: z.literal(true),
        observation: runConfigurationRuntimeWorkerObservationSchema,
      })
      .strict(),
    z
      .object({
        found: z.literal(false),
        identity: runConfigurationRuntimeWorkerIdentitySchema,
      })
      .strict(),
  ],
);

export const runConfigurationRuntimeWorkerReconciliationSchema = z
  .object({
    runtimes: z
      .array(runConfigurationRuntimeWorkerLookupSchema)
      .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
    orphanedRuntimeIds: z
      .array(z.string().uuid())
      .max(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT),
  })
  .strict();

export const runConfigurationRuntimeWorkerOutputSchema = z
  .object({
    requestOperationId: runConfigurationOperationIdSchema,
    identity: runConfigurationRuntimeWorkerIdentitySchema,
    data: z.string().max(RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT),
    truncated: z.boolean(),
  })
  .strict();

export const runConfigurationRuntimeOutputContentSchema = z
  .object({
    data: z.string().max(RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT),
    truncated: z.boolean(),
  })
  .strict();

export const protectedRunConfigurationRuntimeWorkerOutputSchema = z
  .object({
    requestOperationId: runConfigurationOperationIdSchema,
    identity: runConfigurationRuntimeWorkerIdentitySchema,
    protectedOutput: endpointContentOpaqueSchema,
  })
  .strict();

export const protectedRunConfigurationRuntimeOutputResultSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    ...runConfigurationRuntimeIdentitySchema.shape,
    generation: runConfigurationRuntimeSchema.shape.generation,
    protectedOutput: endpointContentOpaqueSchema,
  })
  .strict();

export const runConfigurationRuntimeWorkerNotificationSchema = z
  .object({
    type: z.literal("project.run-configuration-runtime.observed"),
    observation: runConfigurationRuntimeWorkerObservationSchema,
  })
  .strict();

export const runConfigurationRuntimeObservationApplyResultSchema = z
  .object({
    applied: z.boolean(),
    reason: z.enum([
      "applied",
      "unchanged",
      "stale-generation",
      "stale-operation",
      "invalid-transition",
    ]),
    runtime: runConfigurationRuntimeSchema,
  })
  .strict();

export type RunConfigurationRuntimeState = z.infer<
  typeof runConfigurationRuntimeStateSchema
>;
export type RunConfigurationRuntimeOperation = z.infer<
  typeof runConfigurationRuntimeOperationSchema
>;
export type RunConfigurationRuntimeOperationOutcome = z.infer<
  typeof runConfigurationRuntimeOperationOutcomeSchema
>;
export type RunConfigurationRuntimeFailure = z.infer<
  typeof runConfigurationRuntimeFailureSchema
>;
export type RunConfigurationRuntimeIdentity = z.infer<
  typeof runConfigurationRuntimeIdentitySchema
>;
export type RunConfigurationRuntime = z.infer<
  typeof runConfigurationRuntimeSchema
>;
export type RunConfigurationRuntimeLifecycleRequest = z.infer<
  typeof runConfigurationRuntimeLifecycleRequestSchema
>;
export type RunConfigurationRuntimeOperationRecord = z.infer<
  typeof runConfigurationRuntimeOperationRecordSchema
>;
export type RunConfigurationRuntimeOperationResult = z.infer<
  typeof runConfigurationRuntimeOperationResultSchema
>;
export type RunConfigurationRuntimeWorkerIdentity = z.infer<
  typeof runConfigurationRuntimeWorkerIdentitySchema
>;
export type RunConfigurationRuntimeLaunchIdentity = z.infer<
  typeof runConfigurationRuntimeLaunchIdentitySchema
>;
export type RunConfigurationRuntimeWorkerCommand = z.infer<
  typeof runConfigurationRuntimeWorkerCommandSchema
>;
export type RunConfigurationRuntimeWorkerObservation = z.infer<
  typeof runConfigurationRuntimeWorkerObservationSchema
>;
export type RunConfigurationRuntimeWorkerOperationResult = z.infer<
  typeof runConfigurationRuntimeWorkerOperationResultSchema
>;
export type RunConfigurationRuntimeWorkerLookup = z.infer<
  typeof runConfigurationRuntimeWorkerLookupSchema
>;
export type RunConfigurationRuntimeWorkerReconciliation = z.infer<
  typeof runConfigurationRuntimeWorkerReconciliationSchema
>;
export type RunConfigurationRuntimeWorkerOutput = z.infer<
  typeof runConfigurationRuntimeWorkerOutputSchema
>;
export type RunConfigurationRuntimeOutputContent = z.infer<
  typeof runConfigurationRuntimeOutputContentSchema
>;
export type ProtectedRunConfigurationRuntimeOutputResult = z.infer<
  typeof protectedRunConfigurationRuntimeOutputResultSchema
>;
export type RunConfigurationRuntimeObservationApplyResult = z.infer<
  typeof runConfigurationRuntimeObservationApplyResultSchema
>;
