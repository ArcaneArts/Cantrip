import { z } from "zod";
import { repositoryRoutingHandleSchema } from "./repository-operation.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import { githubRepositorySchema } from "./github.js";
import {
  projectGithubConversionRepositorySchema,
  projectGithubRoutingRepositorySchema,
  projectGithubWireRepositorySchema,
  projectReplicaPlacementResultSchema,
  projectReplicaJobErrorSchema,
  gitObjectRevisionSchema,
} from "./projects.js";
import { worktreePolicySchema } from "./worktrees.js";

export const githubWorkerRepositorySchema = githubRepositorySchema.omit({
  imported: true,
});

export const githubWorkerRepositoryListSchema = z.array(
  githubWorkerRepositorySchema,
);

export const projectCloneResultSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean().default(false),
  updated: z.boolean().default(false),
  warning: z.string().min(1).nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const managedFolderMaterializeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean(),
  repositoryFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable()
    .default(null),
  github: projectGithubWireRepositorySchema.nullable().default(null),
});

export const managedFolderDeleteResultSchema = z.object({
  deleted: z.boolean(),
});

export const projectFolderSetupJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectFolderSetupJobErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "materialization-failed",
  ]),
  retryable: z.boolean(),
});

export const projectFolderSetupJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  state: projectFolderSetupJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  error: projectFolderSetupJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectFolderSetupRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "project-not-ready",
    "transition-active",
    "repository-collision",
    "github-auth-required",
    "repository-unavailable",
    "repository-not-empty",
    "local-git-ambiguous",
    "preflight-changed",
    "initial-commit-required",
    "git-initialization-failed",
    "commit-failed",
    "push-failed",
    "reconciliation-failed",
  ]),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const projectGithubConversionJobErrorSchema =
  projectGithubConversionErrorSchema.omit({ message: true });

const projectGithubConversionPreflightBaseSchema = z.object({
  projectId: z.string().uuid(),
  repository: projectGithubWireRepositorySchema,
});

export const projectGithubConversionPreflightReadySchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("ready"),
    projectSourceId: z.string().uuid().optional(),
    workerId: z.string().min(1).optional(),
    confirmationToken: z.string().regex(/^[0-9a-f]{64}$/u),
    localState: z.enum(["not-initialized", "unborn", "committed"]),
    branch: z.string().min(1).max(255).nullable(),
    head: gitObjectRevisionSchema.nullable(),
    dirty: z.boolean(),
    originUrl: z.string().min(1).max(8_192).nullable(),
    remoteAction: z.enum(["push", "link"]).default("push"),
    requiresInitialCommit: z.boolean(),
    warnings: z.array(z.string().min(1).max(1_000)).max(20),
  });

export const projectGithubConversionPreflightBlockedSchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("blocked"),
    error: projectGithubConversionErrorSchema,
  });

export const projectGithubConversionPreflightResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionPreflightReadySchema,
    projectGithubConversionPreflightBlockedSchema,
  ]);

export const projectGithubConversionPreflightRequestSchema = z
  .object({
    repository: projectGithubConversionRepositorySchema,
    projectSourceId: z.string().uuid().optional(),
    workerId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (input) =>
      (input.projectSourceId === undefined) === (input.workerId === undefined),
    { message: "Conversion source fields must be provided together." },
  );

export const encryptedProjectGithubConversionPreflightRequestSchema = z
  .object({
    repository: projectGithubRoutingRepositorySchema,
    repositoryBlindIndex: encryptionKeyBytesSchema,
    projectSourceId: z.string().uuid().optional(),
    workerId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (input) =>
      (input.projectSourceId === undefined) === (input.workerId === undefined),
    { message: "Conversion source fields must be provided together." },
  );

const projectGithubConversionStartObjectSchema = z.object({
  repository: projectGithubConversionRepositorySchema,
  projectSourceId: z.string().uuid().optional(),
  workerId: z.string().min(1).optional(),
  confirmationToken:
    projectGithubConversionPreflightReadySchema.shape.confirmationToken,
  initialCommit: z
    .object({
      message: z.string().trim().min(1).max(1_000),
    })
    .nullable()
    .default(null),
});

export const projectGithubConversionStartSchema =
  projectGithubConversionStartObjectSchema.refine(
    (input) =>
      (input.projectSourceId === undefined) === (input.workerId === undefined),
    { message: "Conversion source fields must be provided together." },
  );

export const encryptedProjectGithubConversionStartSchema =
  projectGithubConversionStartObjectSchema
    .omit({ repository: true, initialCommit: true })
    .extend({
      repository: projectGithubRoutingRepositorySchema,
      repositoryBlindIndex: encryptionKeyBytesSchema,
      initialCommit: z
        .object({ message: repositoryRoutingHandleSchema })
        .nullable(),
    })
    .strict()
    .refine(
      (input) =>
        (input.projectSourceId === undefined) ===
        (input.workerId === undefined),
      { message: "Conversion source fields must be provided together." },
    );

export const projectGithubConversionJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectGithubConversionJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  repository: projectGithubWireRepositorySchema,
  state: projectGithubConversionJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  initialCommitRequested: z.boolean(),
  error: projectGithubConversionJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectGithubConversionRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  repository: projectGithubWireRepositorySchema,
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  branch: z.string().min(1).max(255),
  head: gitObjectRevisionSchema,
  worktreePolicy: worktreePolicySchema,
});

export const projectGithubConversionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectGithubConversionJobErrorSchema,
});

export const projectGithubConversionExecutionResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionReadySchema,
    projectGithubConversionBlockedSchema,
  ]);

export const projectReplicaProvisionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaProvisionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().min(1),
  resolvedRevision: gitObjectRevisionSchema.nullable(),
  branch: z.string().min(1).nullable(),
  reused: z.boolean(),
  placement: projectReplicaPlacementResultSchema.nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const projectReplicaProvisionResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaProvisionReadySchema],
);

export const projectReplicaSynchronizeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  previousRevision: gitObjectRevisionSchema,
  resolvedRevision: gitObjectRevisionSchema,
  branch: z.string().min(1).nullable(),
  changed: z.boolean(),
});

export const projectReplicaSynchronizeResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaSynchronizeReadySchema],
);

export const projectReplicaRemoveReadySchema = z.object({
  status: z.literal("removed"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  localFilesDeleted: z.boolean(),
  linkRemoved: z.boolean().default(false),
  ownershipReleased: z.boolean().default(false),
  warning: z.string().min(1).max(1_000).nullable().default(null),
});

export const projectReplicaRemoveResultSchema = z.discriminatedUnion("status", [
  projectReplicaProvisionBlockedSchema,
  projectReplicaRemoveReadySchema,
]);

export const projectReplicaLinkRepairReadySchema = z.object({
  status: z.literal("ready"),
  projectId: z.string().uuid(),
  path: z.string().min(1).max(8_192),
  linkPath: z.string().min(1).max(8_192),
  repaired: z.boolean(),
});

export const projectReplicaLinkRepairBlockedSchema = z.object({
  status: z.literal("blocked"),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaLinkRepairResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaLinkRepairReadySchema, projectReplicaLinkRepairBlockedSchema],
);

export const projectRemoveSchema = z.object({
  deleteLocalFiles: z.boolean().default(false),
});

export type GithubWorkerRepository = z.infer<
  typeof githubWorkerRepositorySchema
>;
export type ProjectCloneResult = z.infer<typeof projectCloneResultSchema>;
export type ManagedFolderMaterializeReady = z.infer<
  typeof managedFolderMaterializeReadySchema
>;
export type ManagedFolderDeleteResult = z.infer<
  typeof managedFolderDeleteResultSchema
>;
export type ProjectFolderSetupJobState = z.infer<
  typeof projectFolderSetupJobStateSchema
>;
export type ProjectFolderSetupJobError = z.infer<
  typeof projectFolderSetupJobErrorSchema
>;
export type ProjectFolderSetupJobSummary = z.infer<
  typeof projectFolderSetupJobSummarySchema
>;
export type ProjectGithubConversionError = z.infer<
  typeof projectGithubConversionErrorSchema
>;
export type ProjectGithubConversionJobError = z.infer<
  typeof projectGithubConversionJobErrorSchema
>;
export type ProjectGithubConversionPreflightResult = z.infer<
  typeof projectGithubConversionPreflightResultSchema
>;
export type ProjectGithubConversionPreflightReady = z.infer<
  typeof projectGithubConversionPreflightReadySchema
>;
export type ProjectGithubConversionPreflightRequest = z.infer<
  typeof projectGithubConversionPreflightRequestSchema
>;
export type EncryptedProjectGithubConversionPreflightRequest = z.infer<
  typeof encryptedProjectGithubConversionPreflightRequestSchema
>;
export type ProjectGithubConversionStart = z.infer<
  typeof projectGithubConversionStartSchema
>;
export type EncryptedProjectGithubConversionStart = z.infer<
  typeof encryptedProjectGithubConversionStartSchema
>;
export type ProjectGithubConversionJobState = z.infer<
  typeof projectGithubConversionJobStateSchema
>;
export type ProjectGithubConversionJobSummary = z.infer<
  typeof projectGithubConversionJobSummarySchema
>;
export type ProjectGithubConversionReady = z.infer<
  typeof projectGithubConversionReadySchema
>;
export type ProjectGithubConversionExecutionResult = z.infer<
  typeof projectGithubConversionExecutionResultSchema
>;
export type ProjectReplicaProvisionResult = z.infer<
  typeof projectReplicaProvisionResultSchema
>;
export type ProjectReplicaSynchronizeResult = z.infer<
  typeof projectReplicaSynchronizeResultSchema
>;
export type ProjectReplicaRemoveResult = z.infer<
  typeof projectReplicaRemoveResultSchema
>;
export type ProjectReplicaLinkRepairResult = z.infer<
  typeof projectReplicaLinkRepairResultSchema
>;
export type ProjectRemove = z.infer<typeof projectRemoveSchema>;
