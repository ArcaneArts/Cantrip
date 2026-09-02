import { z } from "zod";

import {
  repositoryOperationContextSchema,
  repositoryOperationOpaqueSchema,
  repositoryOperationWireResponseSchema,
  repositoryRoutingHandleSchema,
} from "./repository-operation.js";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyBytesSchema,
} from "./encryption.js";

import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

import { githubRepositorySchema } from "./github.js";

import {
  projectOriginKindSchema,
  projectFolderManagementSchema,
  projectSourceKindSchema,
  projectCapabilitiesSchema,
  projectCapabilitySchema,
  projectCapabilitiesForOriginKind,
  projectCapabilitiesForSource,
} from "./project-foundation.js";

import { worktreePolicySchema } from "./worktrees.js";

export const projectGithubConversionRepositorySchema = z.object({
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: githubRepositorySchema.shape.url,
});

export const projectGithubRoutingRepositorySchema = z.object({
  repositoryId: repositoryRoutingHandleSchema,
  nameWithOwner: repositoryRoutingHandleSchema,
  url: repositoryRoutingHandleSchema,
});

export const projectGithubWireRepositorySchema = z.union([
  projectGithubConversionRepositorySchema,
  projectGithubRoutingRepositorySchema,
]);

export const projectReplicaPlacementModeSchema = z.enum([
  "managed",
  "managed-link",
  "direct",
]);

const projectReplicaManagedPlacementSchema = z
  .object({ mode: z.literal("managed") })
  .strict();

const projectReplicaManagedLinkPlacementSchema = z
  .object({
    mode: z.literal("managed-link"),
    path: z.string().trim().min(1).max(8_192),
  })
  .strict();

const projectReplicaDirectPlacementSchema = z
  .object({
    mode: z.literal("direct"),
    path: z.string().trim().min(1).max(8_192),
  })
  .strict();

export const projectReplicaPlacementRequestSchema = z.discriminatedUnion(
  "mode",
  [
    projectReplicaManagedPlacementSchema,
    projectReplicaManagedLinkPlacementSchema,
    projectReplicaDirectPlacementSchema,
  ],
);

export const encryptedProjectReplicaPlacementRequestSchema =
  z.discriminatedUnion("mode", [
    projectReplicaManagedPlacementSchema,
    z
      .object({
        mode: z.literal("managed-link"),
        path: repositoryRoutingHandleSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("direct"),
        path: repositoryRoutingHandleSchema,
      })
      .strict(),
  ]);

export const projectReplicaMaterializationSchema = z.enum([
  "cloned",
  "reused",
  "attached",
]);

export const projectReplicaOwnershipKindSchema = z.enum(["cantrip", "user"]);

export const projectReplicaPlacementResultSchema = z
  .object({
    mode: projectReplicaPlacementModeSchema,
    materialization: projectReplicaMaterializationSchema,
    ownership: projectReplicaOwnershipKindSchema,
    canonicalPath: z.string().min(1).max(8_192),
    requestedPath: z.string().min(1).max(8_192).nullable(),
    linkPath: z.string().min(1).max(8_192).nullable(),
  })
  .strict();

export const githubProjectCreateSchema = z.object({
  workerId: z.string().min(1),
  repositoryId: z.string().min(1),
  nameWithOwner: githubRepositorySchema.shape.nameWithOwner,
  url: z.url(),
  placement: projectReplicaPlacementRequestSchema.optional(),
  workspaceId: z.string().min(1).optional(),
});

export const encryptedGithubProjectCreateSchema = githubProjectCreateSchema
  .omit({ repositoryId: true, nameWithOwner: true, placement: true, url: true })
  .extend({
    id: z.string().uuid(),
    nameProtection: privateDisplayLabelOpaqueSchema,
    repositoryBlindIndex: encryptionKeyBytesSchema,
    repositoryId: repositoryRoutingHandleSchema,
    nameWithOwner: repositoryRoutingHandleSchema,
    placement: encryptedProjectReplicaPlacementRequestSchema.optional(),
    url: repositoryRoutingHandleSchema,
  })
  .strict();

export const managedFolderProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workerId: z.string().min(1),
  existingPath: z.string().trim().min(1).max(8_192).optional(),
  workspaceId: z.string().min(1).optional(),
});

export const encryptedManagedFolderProjectCreateSchema =
  managedFolderProjectCreateSchema
    .omit({ name: true, existingPath: true })
    .extend({
      id: z.string().uuid(),
      nameProtection: privateDisplayLabelOpaqueSchema,
      existingPath: repositoryRoutingHandleSchema.optional(),
    })
    .strict();

export const projectWorkspaceStorageKindSchema = z.enum([
  "system",
  "legacy",
  "managed",
  "attached",
]);

export function projectWorkspaceStorageCanBeDefault(
  kind: z.infer<typeof projectWorkspaceStorageKindSchema>,
): boolean {
  return kind !== "attached";
}

const projectWorkspaceManagedStorageCreateSchema = z
  .object({ kind: z.literal("managed") })
  .strict();

const projectWorkspaceAttachedStorageCreateSchema = z
  .object({
    kind: z.literal("attached"),
    workerId: z.string().min(1),
    rootPath: z.string().trim().min(1).max(8_192),
  })
  .strict();

export const projectWorkspaceStorageCreateSchema = z.discriminatedUnion(
  "kind",
  [
    projectWorkspaceManagedStorageCreateSchema,
    projectWorkspaceAttachedStorageCreateSchema,
  ],
);

const projectWorkspacePortableStorageProfileSchema = z
  .object({
    kind: z.enum(["system", "legacy", "managed"]),
  })
  .strict();

const projectWorkspaceAttachedStorageProfileSchema = z
  .object({
    kind: z.literal("attached"),
    workerId: z.string().min(1),
    rootPathHandle: repositoryRoutingHandleSchema,
    displayHandle: repositoryRoutingHandleSchema,
  })
  .strict();

export const projectWorkspaceStorageProfileSchema = z.discriminatedUnion(
  "kind",
  [
    projectWorkspacePortableStorageProfileSchema,
    projectWorkspaceAttachedStorageProfileSchema,
  ],
);

const projectWorkspacePortableStorageContextSchema = z
  .object({
    kind: z.enum(["system", "legacy"]),
  })
  .strict();

const projectWorkspaceManagedStorageContextSchema = z
  .object({
    kind: z.literal("managed"),
    workspaceId: z.string().uuid(),
  })
  .strict();

const projectWorkspaceAttachedStorageContextSchema = z
  .object({
    kind: z.literal("attached"),
    workspaceId: z.string().uuid(),
    workerId: z.string().min(1),
  })
  .strict();

/**
 * Worker-safe workspace identity used when deriving project storage paths.
 * Attached roots remain opaque and are deliberately absent from this payload.
 */
export const projectWorkspaceStorageContextSchema = z.discriminatedUnion(
  "kind",
  [
    projectWorkspacePortableStorageContextSchema,
    projectWorkspaceManagedStorageContextSchema,
    projectWorkspaceAttachedStorageContextSchema,
  ],
);

const encryptedProjectWorkspaceAttachedStorageCreateSchema = z
  .object({
    kind: z.literal("attached"),
    workerId: z.string().min(1),
    rootPathHandle: repositoryRoutingHandleSchema,
    displayHandle: repositoryRoutingHandleSchema,
  })
  .strict();

export const encryptedProjectWorkspaceStorageCreateSchema =
  z.discriminatedUnion("kind", [
    projectWorkspaceManagedStorageCreateSchema,
    encryptedProjectWorkspaceAttachedStorageCreateSchema,
  ]);

export const projectWorkspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    storage: projectWorkspaceStorageCreateSchema,
  })
  .strict();

export const projectWorkspaceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.isDefault !== undefined,
    { message: "At least one workspace field is required." },
  );

const projectWorkspaceWireBaseSchema = z
  .object({
    id: z.string().min(1).max(255),
    storage: projectWorkspaceStorageProfileSchema,
    position: z.number().int().nonnegative(),
    isDefault: z.boolean(),
    projectIds: z.array(z.string().min(1)),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const encryptedProjectWorkspaceNameSchema = z
  .object({
    state: z.literal("encrypted"),
    formatVersion: z.literal(1),
    keyRevision: z.number().int().positive(),
    blindIndex: encryptionKeyBytesSchema,
    envelope: encryptedPayloadEnvelopeSchema.refine(
      (envelope) => envelope.ciphertext.length <= 448,
      "Encrypted workspace name is too large.",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.envelope.keyRevision !== value.keyRevision) {
      context.addIssue({
        code: "custom",
        message: "Workspace name and envelope key revisions must match.",
        path: ["envelope", "keyRevision"],
      });
    }
  });

export const systemDefaultProjectWorkspaceNameSchema = z
  .object({
    state: z.literal("system-default"),
  })
  .strict();

export const projectWorkspaceWireSummarySchema =
  projectWorkspaceWireBaseSchema.extend({
    nameProtection: z.discriminatedUnion("state", [
      encryptedProjectWorkspaceNameSchema,
      systemDefaultProjectWorkspaceNameSchema,
    ]),
  });

export const projectWorkspaceWireListSchema = z
  .object({
    workspaces: z.array(projectWorkspaceWireSummarySchema),
  })
  .strict();

export const encryptedProjectWorkspaceCreateSchema = z
  .object({
    id: z.string().uuid(),
    nameProtection: encryptedProjectWorkspaceNameSchema,
    storage: encryptedProjectWorkspaceStorageCreateSchema,
  })
  .strict();

export const encryptedAttachedProjectWorkspaceCreateSchema = z
  .object({
    id: z.string().uuid(),
    nameProtection: encryptedProjectWorkspaceNameSchema,
    storage: z
      .object({
        kind: z.literal("attached"),
        workerId: z.string().min(1),
      })
      .strict(),
    operationId: repositoryOperationContextSchema.shape.operationId,
    protectedRequest: repositoryOperationOpaqueSchema,
  })
  .strict();

export const encryptedAttachedProjectWorkspaceCreateResultSchema = z
  .object({
    workspace: projectWorkspaceWireSummarySchema.nullable(),
    operation: repositoryOperationWireResponseSchema,
  })
  .strict();

export const encryptedProjectWorkspaceUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    nameProtection: encryptedProjectWorkspaceNameSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.nameProtection !== undefined || input.isDefault !== undefined,
    { message: "At least one workspace field is required." },
  );

export const projectWorkspaceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  storage: projectWorkspaceStorageProfileSchema,
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  projectIds: z.array(z.string().min(1)),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorkspaceListSchema = z.array(
  projectWorkspaceSummarySchema,
);

export const projectSourceSummarySchema = z.object({
  id: z.string().min(1),
  sourceKind: projectSourceKindSchema.default("git"),
  workerId: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  ownershipKind: projectReplicaOwnershipKindSchema.default("cantrip"),
  requestedPath: z.string().min(1).nullable().default(null),
  linkPath: z.string().min(1).nullable().default(null),
});

export const projectReplicaSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceKind: projectSourceKindSchema.default("git"),
  workerId: z.string().min(1),
  workerName: z.string().min(1),
  workerOnline: z.boolean(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  ownershipKind: projectReplicaOwnershipKindSchema.default("cantrip"),
  requestedPath: z.string().min(1).nullable().default(null),
  linkPath: z.string().min(1).nullable().default(null),
  repositoryFingerprint: z.string().min(1).nullable(),
  primaryWorktreeId: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  dirty: z.boolean().nullable(),
  ready: z.boolean(),
  worktreeCount: z.number().int().nonnegative(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectReplicaListSchema = z
  .array(projectReplicaSummarySchema)
  .max(1_000);

export const projectReplicaJobKindSchema = z.enum([
  "provision",
  "synchronize",
  "remove",
]);

export const projectReplicaJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const projectReplicaJobErrorCodeSchema = z.enum([
  "target-not-found",
  "target-mismatch",
  "worker-offline",
  "capability-missing",
  "replica-not-ready",
  "worktree-dirty",
  "revision-diverged",
  "lease-conflict",
  "attachment-unavailable",
  "runtime-incompatible",
  "stale-attempt",
  "policy-denied",
  "remote-unavailable",
  "windows-long-paths-disabled",
  "placement-unsupported",
  "path-invalid",
  "path-permission-denied",
  "parent-creation-failed",
  "target-type-mismatch",
  "target-repository-mismatch",
  "target-not-primary-worktree",
  "target-owned-by-another-project",
  "target-revision-mismatch",
  "link-unsupported",
  "link-target-mismatch",
  "ownership-proof-missing",
  "replica-in-use",
  "unpushed-commits",
  "worker-error",
]);

export const projectReplicaJobErrorSchema = z.object({
  code: projectReplicaJobErrorCodeSchema,
  retryable: z.boolean(),
});

export const projectReplicaJobProgressStageSchema = z.enum([
  "queued",
  "dispatching",
  "validating",
  "validating-placement",
  "inspecting-existing-checkout",
  "fetching",
  "inspecting",
  "materializing",
  "resolving-revision",
  "verifying",
  "fast-forwarding",
  "removing",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

export const projectReplicaJobProgressSchema = z.object({
  stage: projectReplicaJobProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const projectReplicaJobProgressEventSchema =
  projectReplicaJobProgressSchema.omit({ updatedAt: true });

export const gitObjectRevisionSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{40,64}$/u);

export const projectReplicaJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  projectReplicaId: z.string().min(1).nullable(),
  workerId: z.string().min(1),
  kind: projectReplicaJobKindSchema,
  state: projectReplicaJobStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  repository: z.string().min(1).nullable(),
  placementMode: projectReplicaPlacementModeSchema.default("managed"),
  placementPath: z.string().min(1).nullable().default(null),
  resolvedMaterialization: projectReplicaMaterializationSchema
    .nullable()
    .default(null),
  resolvedOwnership: projectReplicaOwnershipKindSchema.nullable().default(null),
  expectedRevision: gitObjectRevisionSchema.nullable(),
  resolvedRevision: gitObjectRevisionSchema.nullable(),
  synchronizationPolicy: z
    .enum(["verify-only", "fast-forward-primary"])
    .nullable()
    .default(null),
  deleteLocalFiles: z.boolean().nullable().default(null),
  attempt: z.number().int().nonnegative(),
  progress: projectReplicaJobProgressSchema,
  error: projectReplicaJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancellationUnsafeAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectReplicaJobListSchema = z
  .array(projectReplicaJobSummarySchema)
  .max(1_000);

export const projectReplicaProvisionCreateSchema = z.object({
  workerId: z.string().min(1),
  placement: projectReplicaPlacementRequestSchema.optional(),
  expectedRevision: gitObjectRevisionSchema.nullable().default(null),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaProvisionCreateSchema =
  projectReplicaProvisionCreateSchema
    .omit({ placement: true })
    .extend({
      placement: encryptedProjectReplicaPlacementRequestSchema.optional(),
      repository: repositoryRoutingHandleSchema.nullable(),
    })
    .strict();

export const projectReplicaSynchronizationPolicySchema = z.enum([
  "verify-only",
  "fast-forward-primary",
]);

export const projectReplicaSynchronizeCreateSchema = z.object({
  expectedRevision: gitObjectRevisionSchema,
  policy: projectReplicaSynchronizationPolicySchema.default("verify-only"),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaSynchronizeCreateSchema =
  projectReplicaSynchronizeCreateSchema
    .extend({ repository: repositoryRoutingHandleSchema })
    .strict();

export const projectReplicaRemoveCreateSchema = z.object({
  deleteLocalFiles: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const encryptedProjectReplicaRemoveCreateSchema =
  projectReplicaRemoveCreateSchema
    .extend({ repository: repositoryRoutingHandleSchema.nullable() })
    .strict();

export const projectReplicaJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectReplicaJobCancelSchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectSetupStatusSchema = z.enum([
  "preparing",
  "cloning",
  "ready",
  "failed",
]);

const projectSummaryBaseSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().nonnegative(),
  originKind: projectOriginKindSchema.default("github"),
  folderManagement: projectFolderManagementSchema.nullable().optional(),
  capabilities: projectCapabilitiesSchema.default(
    projectCapabilitiesForOriginKind("github"),
  ),
  setupStatus: projectSetupStatusSchema,
  setupError: z.string().min(1).nullable(),
  worktreePolicy: worktreePolicySchema,
  preferredWorkerId: z.string().min(1).nullable().optional(),
  source: projectSourceSummarySchema.nullable(),
  replicas: projectReplicaListSchema.default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

function refineProjectSummary(
  project: z.infer<typeof projectSummaryBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    (project.originKind === "github" && project.folderManagement != null) ||
    (project.originKind === "managed-folder" &&
      project.folderManagement === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "folder management must match the project origin",
      path: ["folderManagement"],
    });
  }
  const expected = projectCapabilitiesForSource({
    originKind: project.originKind,
    git: project.capabilities.git,
    github: project.capabilities.github,
  });
  for (const capability of projectCapabilitySchema.options) {
    if (project.capabilities[capability] !== expected[capability]) {
      context.addIssue({
        code: "custom",
        message: `${capability} capability does not match ${project.originKind} origin`,
        path: ["capabilities", capability],
      });
    }
  }
  if (project.capabilities.github && !project.capabilities.git) {
    context.addIssue({
      code: "custom",
      message: "github capability requires git capability",
      path: ["capabilities", "github"],
    });
  }
}

export const projectSummarySchema = projectSummaryBaseSchema
  .extend({
    name: z.string().min(1).max(1_000),
    github: projectGithubConversionRepositorySchema.nullable(),
  })
  .strict()
  .superRefine(refineProjectSummary);

export const projectWireSummarySchema = projectSummaryBaseSchema
  .extend({
    nameProtection: privateDisplayLabelOpaqueSchema,
    github: projectGithubWireRepositorySchema.nullable(),
  })
  .strict()
  .superRefine((project, context) => {
    refineProjectSummary(project, context);
    if (project.nameProtection.classification.recordKind !== "project") {
      context.addIssue({
        code: "custom",
        message: "Project display-label classification must be project.",
        path: ["nameProtection", "classification", "recordKind"],
      });
    }
  });

export const projectListSchema = z.array(projectSummarySchema);
export const projectWireListSchema = z.array(projectWireSummarySchema);

export const projectPreferredWorkerUpdateSchema = z.object({
  workerId: z.string().min(1).nullable(),
});

export type ProjectReplicaPlacementMode = z.infer<
  typeof projectReplicaPlacementModeSchema
>;

export type ProjectReplicaPlacementRequest = z.infer<
  typeof projectReplicaPlacementRequestSchema
>;

export type EncryptedProjectReplicaPlacementRequest = z.infer<
  typeof encryptedProjectReplicaPlacementRequestSchema
>;

export type ProjectReplicaMaterialization = z.infer<
  typeof projectReplicaMaterializationSchema
>;

export type ProjectReplicaOwnershipKind = z.infer<
  typeof projectReplicaOwnershipKindSchema
>;

export type ProjectReplicaPlacementResult = z.infer<
  typeof projectReplicaPlacementResultSchema
>;

export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export type ProjectWireSummary = z.infer<typeof projectWireSummarySchema>;

export type ProjectPreferredWorkerUpdate = z.infer<
  typeof projectPreferredWorkerUpdateSchema
>;

export type ProjectReplicaSummary = z.infer<typeof projectReplicaSummarySchema>;

export type ProjectReplicaJobKind = z.infer<typeof projectReplicaJobKindSchema>;

export type ProjectReplicaJobState = z.infer<
  typeof projectReplicaJobStateSchema
>;

export type ProjectReplicaJobErrorCode = z.infer<
  typeof projectReplicaJobErrorCodeSchema
>;

export type ProjectReplicaJobError = z.infer<
  typeof projectReplicaJobErrorSchema
>;

export type ProjectReplicaJobProgress = z.infer<
  typeof projectReplicaJobProgressSchema
>;

export type ProjectReplicaJobProgressEvent = z.infer<
  typeof projectReplicaJobProgressEventSchema
>;

export type ProjectReplicaJobSummary = z.infer<
  typeof projectReplicaJobSummarySchema
>;

export type ProjectReplicaProvisionCreate = z.infer<
  typeof projectReplicaProvisionCreateSchema
>;

export type EncryptedProjectReplicaProvisionCreate = z.infer<
  typeof encryptedProjectReplicaProvisionCreateSchema
>;

export type ProjectReplicaSynchronizationPolicy = z.infer<
  typeof projectReplicaSynchronizationPolicySchema
>;

export type ProjectReplicaSynchronizeCreate = z.infer<
  typeof projectReplicaSynchronizeCreateSchema
>;

export type EncryptedProjectReplicaSynchronizeCreate = z.infer<
  typeof encryptedProjectReplicaSynchronizeCreateSchema
>;

export type ProjectReplicaRemoveCreate = z.infer<
  typeof projectReplicaRemoveCreateSchema
>;

export type EncryptedProjectReplicaRemoveCreate = z.infer<
  typeof encryptedProjectReplicaRemoveCreateSchema
>;

export type ProjectReplicaJobRetry = z.infer<
  typeof projectReplicaJobRetrySchema
>;

export type ProjectReplicaJobCancel = z.infer<
  typeof projectReplicaJobCancelSchema
>;

export type ProjectWorkspaceCreate = z.infer<
  typeof projectWorkspaceCreateSchema
>;

export type ProjectWorkspaceStorageKind = z.infer<
  typeof projectWorkspaceStorageKindSchema
>;

export type ProjectWorkspaceStorageCreate = z.infer<
  typeof projectWorkspaceStorageCreateSchema
>;

export type EncryptedProjectWorkspaceStorageCreate = z.infer<
  typeof encryptedProjectWorkspaceStorageCreateSchema
>;

export type ProjectWorkspaceStorageProfile = z.infer<
  typeof projectWorkspaceStorageProfileSchema
>;

export type ProjectWorkspaceStorageContext = z.infer<
  typeof projectWorkspaceStorageContextSchema
>;

export type ProjectWorkspaceUpdate = z.infer<
  typeof projectWorkspaceUpdateSchema
>;

export type ProjectWorkspaceSummary = z.infer<
  typeof projectWorkspaceSummarySchema
>;

export type EncryptedProjectWorkspaceName = z.infer<
  typeof encryptedProjectWorkspaceNameSchema
>;

export type ProjectWorkspaceWireSummary = z.infer<
  typeof projectWorkspaceWireSummarySchema
>;

export type ProjectWorkspaceWireList = z.infer<
  typeof projectWorkspaceWireListSchema
>;

export type EncryptedProjectWorkspaceCreate = z.infer<
  typeof encryptedProjectWorkspaceCreateSchema
>;

export type EncryptedAttachedProjectWorkspaceCreate = z.infer<
  typeof encryptedAttachedProjectWorkspaceCreateSchema
>;

export type EncryptedAttachedProjectWorkspaceCreateResult = z.infer<
  typeof encryptedAttachedProjectWorkspaceCreateResultSchema
>;

export type EncryptedProjectWorkspaceUpdate = z.infer<
  typeof encryptedProjectWorkspaceUpdateSchema
>;

export type GithubProjectCreate = z.infer<typeof githubProjectCreateSchema>;

export type EncryptedGithubProjectCreate = z.infer<
  typeof encryptedGithubProjectCreateSchema
>;

export type ManagedFolderProjectCreate = z.infer<
  typeof managedFolderProjectCreateSchema
>;

export type EncryptedManagedFolderProjectCreate = z.infer<
  typeof encryptedManagedFolderProjectCreateSchema
>;

export type ProjectGithubConversionRepository = z.infer<
  typeof projectGithubConversionRepositorySchema
>;

export type ProjectGithubRoutingRepository = z.infer<
  typeof projectGithubRoutingRepositorySchema
>;
