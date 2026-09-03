import { z } from "zod";
import { repositoryOperationWireRequestSchema } from "./repository-operation.js";
import { mcpServerOpaqueRuntimeSchema } from "./protected-secrets.js";
import {
  gitRelativePathSchema,
  gitComparisonModeSchema,
  gitGraphRequestSchema,
  gitGraphCommitOverlayRequestSchema,
  gitCommitSearchQuerySchema,
  gitRecoveryActionSchema,
  gitRecoveryApplySchema,
  gitDiffContextLinesSchema,
  gitDiffScopeSchema,
  gitPartialPatchRequestSchema,
  gitPartialPatchApplySchema,
  gitStashCreateSchema,
  gitStashActionSchema,
  gitStashActionApplySchema,
  gitBranchActionSchema,
  gitBranchActionApplySchema,
  gitRemoteActionSchema,
  gitRemoteActionApplySchema,
  gitSubmoduleActionSchema,
  gitSubmoduleActionApplySchema,
  gitLfsActionSchema,
  gitLfsActionApplySchema,
  gitTagNameInputSchema,
  gitTagActionSchema,
  gitTagActionApplySchema,
} from "./git-contracts.js";
import {
  gitCommitActionSchema,
  gitManagedOperationActionSchema,
  gitManagedOperationContextSchema,
  gitManagedOperationStartSchema,
  gitManagedOperationControlSchema,
  gitManagedOperationAmendSchema,
  gitConflictResolutionRequestSchema,
  gitConflictResolutionApplySchema,
  gitCommitActionApplySchema,
  gitActionSchema,
  gitForcePushApplySchema,
} from "./git-actions.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
} from "./worker-runtime-support.js";
import { workerRepositoryNameSchema } from "./worker-command-shared.js";

export const workerGitCommandSchemas = [
  z.object({
    type: z.literal("git.history"),
    cwd: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z
    .object({
      type: z.literal("git.graph.snapshot"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.metrics"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.commit-overlay"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphCommitOverlayRequestSchema.shape),
  z.object({
    type: z.literal("git.file.history"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.file.blame"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  z.object({
    type: z.literal("git.commit.search"),
    cwd: z.string().min(1).max(8_192),
    query: gitCommitSearchQuerySchema,
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.list"),
    cwd: z.string().min(1).max(8_192),
    kind: z.enum(["reflog", "dangling"]),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRecoveryActionSchema,
  }),
  z.object({
    type: z.literal("git.recovery.apply"),
    cwd: z.string().min(1).max(8_192),
    request: gitRecoveryApplySchema,
  }),
  z.object({
    type: z.literal("git.commit.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    parentIndex: z.number().int().nonnegative().default(0),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z.object({
    type: z.literal("git.commit.signature.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  }),
  z.object({
    type: z.literal("git.refs.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.compare"),
    cwd: z.string().min(1).max(8_192),
    left: z.string().regex(/^[0-9a-f]{40,64}$/u),
    right: z.string().regex(/^[0-9a-f]{40,64}$/u),
    mode: gitComparisonModeSchema,
  }),
  z.object({
    type: z.literal("git.revision.diff"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    baseRevision: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    path: gitRelativePathSchema,
    contextLines: gitDiffContextLinesSchema.default(3),
  }),
  z.object({
    type: z.literal("git.status"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.diff"),
    cwd: z.string().min(1),
    path: gitRelativePathSchema,
    scope: gitDiffScopeSchema,
    contextLines: gitDiffContextLinesSchema.default(3),
  }),
  z.object({
    type: z.literal("git.patch.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitPartialPatchRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.patch.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitPartialPatchApplySchema.shape),
  z.object({
    type: z.literal("git.stash.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.stash.create"),
    cwd: z.string().min(1).max(8_192),
    request: gitStashCreateSchema,
  }),
  z.object({
    type: z.literal("git.stash.diff"),
    cwd: z.string().min(1).max(8_192),
    hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
    path: gitRelativePathSchema,
    contextLines: gitDiffContextLinesSchema.default(3),
  }),
  z.object({
    type: z.literal("git.stash.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitStashActionSchema,
  }),
  z
    .object({
      type: z.literal("git.stash.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitStashActionApplySchema.shape),
  z.object({
    type: z.literal("git.branch.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.branch.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitBranchActionSchema,
  }),
  z
    .object({
      type: z.literal("git.branch.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitBranchActionApplySchema.shape),
  z.object({
    type: z.literal("git.remote.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.remote.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRemoteActionSchema,
  }),
  z
    .object({
      type: z.literal("git.remote.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitRemoteActionApplySchema.shape),
  z.object({
    type: z.literal("git.submodule.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.submodule.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitSubmoduleActionSchema,
  }),
  z
    .object({
      type: z.literal("git.submodule.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitSubmoduleActionApplySchema.shape),
  z.object({
    type: z.literal("git.lfs.status"),
    cwd: z.string().min(1).max(8_192),
    refreshLocks: z.boolean(),
  }),
  z.object({
    type: z.literal("git.lfs.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitLfsActionSchema,
  }),
  z
    .object({
      type: z.literal("git.lfs.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitLfsActionApplySchema.shape),
  z.object({
    type: z.literal("git.tag.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.tag.get"),
    cwd: z.string().min(1).max(8_192),
    name: gitTagNameInputSchema,
  }),
  z.object({
    type: z.literal("git.tag.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitTagActionSchema,
  }),
  z
    .object({
      type: z.literal("git.tag.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitTagActionApplySchema.shape),
  z.object({
    type: z.literal("git.commit.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitCommitActionSchema,
  }),
  z
    .object({
      type: z.literal("git.commit.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitCommitActionApplySchema.shape),
  z.object({
    type: z.literal("git.operation.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitManagedOperationActionSchema,
  }),
  z
    .object({
      type: z.literal("git.operation.start"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitManagedOperationStartSchema.shape),
  z.object({
    type: z.literal("git.operation.inspect"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
  }),
  z.object({
    type: z.literal("git.operation.control"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
    action: gitManagedOperationControlSchema.shape.action,
  }),
  z
    .object({
      type: z.literal("git.operation.amend"),
      cwd: z.string().min(1).max(8_192),
      context: gitManagedOperationContextSchema,
    })
    .extend(gitManagedOperationAmendSchema.shape),
  z.object({
    type: z.literal("git.conflicts.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.conflicts.get"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.conflicts.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitConflictResolutionRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.conflicts.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitConflictResolutionApplySchema.shape),
  z.object({
    type: z.literal("git.action"),
    cwd: z.string().min(1),
    action: gitActionSchema,
  }),
  z.object({
    type: z.literal("git.force-push.preview"),
    cwd: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("git.force-push.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitForcePushApplySchema.shape),
  z
    .object({
      type: z.literal("repository.operation"),
      serverId: z.string().min(1).max(2_000),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      cwd: z.string().min(1).max(8_192),
      sourcePath: z.string().min(1).max(8_192),
      repository: workerRepositoryNameSchema.nullable(),
      agentRuntimes: z
        .array(
          z
            .object({
              routeId: z.string().min(1).max(200),
              model: workerRuntimeModelSchema,
              provider: workerRuntimeProviderSchema,
            })
            .strict(),
        )
        .max(20)
        .default([]),
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
      routingPurpose: z
        .enum(["repository", "workspace-root-attachment"])
        .default("repository"),
    })
    .extend(repositoryOperationWireRequestSchema.shape)
    .strict(),
] as const;
