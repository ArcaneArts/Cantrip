import { z } from "zod";
import {
  gitRelativePathSchema,
  gitCommitFileSchema,
  gitComparisonCommitSchema,
  gitFileChangeSchema,
  gitStatusSchema,
  gitBranchNameInputSchema,
  gitRemoteNameInputSchema,
  gitRevisionInputSchema,
} from "./git-contracts.js";

const gitCommitHashInputSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

export const gitCherryPickSelectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commits"),
    revisions: z.array(gitCommitHashInputSchema).min(1).max(1_000),
  }),
  z.object({
    type: z.literal("range"),
    fromRevision: gitCommitHashInputSchema,
    toRevision: gitCommitHashInputSchema,
  }),
]);

export const gitCommitActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cherryPick"),
    selection: gitCherryPickSelectionSchema,
  }),
  z.object({
    type: z.literal("revert"),
    revision: gitCommitHashInputSchema,
    mainlineParent: z.number().int().positive().max(64).nullable(),
  }),
  z.object({
    type: z.literal("amend"),
    message: z.string().min(1).max(1_000_000).nullable(),
  }),
  z.object({
    type: z.literal("fixup"),
    revision: gitCommitHashInputSchema,
  }),
]);

export const gitOperationSummarySchema = z.object({
  type: z.enum(["cherry-pick", "revert"]),
  state: z.enum([
    "queued",
    "running",
    "conflicted",
    "awaiting-user-action",
    "completed",
    "failed",
    "aborted",
  ]),
  originalHead: gitCommitHashInputSchema,
  currentHead: gitCommitHashInputSchema,
  sourceRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  currentStep: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive().max(1_000),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
});

export const gitManagedOperationTypeSchema = z.enum([
  "merge",
  "rebase",
  "bisect",
  "cherry-pick",
  "revert",
  "stash",
]);

export const gitManagedOperationStateSchema = z.enum([
  "queued",
  "running",
  "conflicted",
  "awaiting-user-action",
  "completed",
  "failed",
  "aborted",
]);

export const gitInteractiveRebaseTodoActionSchema = z.enum([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
]);

export const gitInteractiveRebaseTodoItemSchema = z
  .object({
    action: gitInteractiveRebaseTodoActionSchema,
    revision: gitCommitHashInputSchema,
    message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
  })
  .superRefine((item, context) => {
    if (item.action === "reword" && !item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Reword steps require a replacement commit message.",
      });
    }
    if (item.action !== "reword" && item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Only reword steps accept a replacement commit message.",
      });
    }
  });

export const gitMergeRebaseActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("merge"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("rebase"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("interactiveRebase"),
    upstreamRef: gitRevisionInputSchema,
    todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  }),
]);

export const gitBisectActionSchema = z.object({
  type: z.literal("bisect"),
  goodRef: gitRevisionInputSchema,
  badRef: gitRevisionInputSchema,
});

export const gitManagedOperationActionSchema = z.union([
  gitMergeRebaseActionSchema,
  gitBisectActionSchema,
]);

export const gitManagedOperationContextSchema = z.object({
  type: gitManagedOperationTypeSchema,
  originalHead: gitCommitHashInputSchema,
  sourceRef: z.string().min(1).max(1_024).nullable(),
  sourceRevision: gitCommitHashInputSchema.nullable(),
  targetRef: z.string().min(1).max(1_024).nullable(),
  targetRevision: gitCommitHashInputSchema,
  pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
  totalSteps: z.number().int().positive().max(10_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitManagedOperationWorkerStateSchema =
  gitManagedOperationContextSchema.extend({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    status: gitStatusSchema,
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitOperationObservationStateSchema = z
  .object({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    totalSteps: z.number().int().positive().max(10_000),
    pendingCommitCount: z.number().int().nonnegative().max(10_000),
    conflictedPathCount: z.number().int().nonnegative().max(100_000),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable(),
  })
  .strict();

export const gitManagedOperationPreviewSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  context: gitManagedOperationContextSchema,
  commits: z.array(gitComparisonCommitSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  todoText: z.string().max(2_000_000).default(""),
  publishedRefs: z.array(z.string().min(1).max(1_024)).max(1_000).default([]),
});

export const gitManagedOperationStartSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitManagedOperationControlSchema = z.object({
  action: z.enum(["continue", "skip", "abort", "good", "bad", "reset"]),
});

export const gitManagedOperationAmendSchema = z.object({
  message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
});

export const gitManagedOperationRecordSchema =
  gitManagedOperationContextSchema.extend({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    worktreeId: z.string().uuid(),
    workerId: z.string().min(1).max(255),
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    error: z.string().max(1_000_000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitManagedOperationResponseSchema = z.object({
  operation: gitManagedOperationRecordSchema.nullable(),
});

export const gitConflictKindSchema = z.enum([
  "both-modified",
  "both-added",
  "both-deleted",
  "added-by-ours",
  "added-by-theirs",
  "deleted-by-ours",
  "deleted-by-theirs",
  "unknown",
]);

export const gitConflictStageSchema = z.object({
  available: z.boolean(),
  oid: gitCommitHashInputSchema.nullable(),
  mode: z
    .string()
    .regex(/^[0-7]{6}$/u)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  content: z.string().max(2_000_000).nullable(),
  truncated: z.boolean(),
});

export const gitConflictSummarySchema = z.object({
  path: gitRelativePathSchema,
  code: z.string().length(2),
  kind: gitConflictKindSchema,
  baseAvailable: z.boolean(),
  oursAvailable: z.boolean(),
  theirsAvailable: z.boolean(),
});

export const gitConflictListSchema = z.object({
  files: z.array(gitConflictSummarySchema).max(100_000),
  truncated: z.boolean(),
});

export const gitConflictDetailSchema = gitConflictSummarySchema.extend({
  base: gitConflictStageSchema,
  ours: gitConflictStageSchema,
  theirs: gitConflictStageSchema,
  result: z.object({
    exists: z.boolean(),
    oid: gitCommitHashInputSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    content: z.string().max(2_000_000).nullable(),
    truncated: z.boolean(),
  }),
});

export const gitConflictResolutionStrategySchema = z.enum([
  "ours",
  "theirs",
  "both",
  "result",
  "manual",
  "delete",
]);

export const gitConflictResolutionRequestSchema = z
  .object({
    path: gitRelativePathSchema,
    strategy: gitConflictResolutionStrategySchema,
    content: z.string().max(2_000_000).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.strategy === "manual" && value.content === null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Manual conflict resolution requires result content.",
      });
    }
    if (value.strategy !== "manual" && value.content !== null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Only manual conflict resolution accepts result content.",
      });
    }
  });

export const gitConflictResolutionPreviewSchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  resultDeleted: z.boolean(),
  resultBinary: z.boolean(),
  resultContent: z.string().max(2_000_000).nullable(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitConflictResolutionApplySchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitConflictResolutionResultSchema = z.object({
  path: gitRelativePathSchema,
  resolved: z.boolean(),
  remainingPaths: z.array(gitRelativePathSchema).max(100_000),
  status: gitStatusSchema,
});

export const gitCommitActionPreviewSchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  resolvedRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  commits: z.array(gitComparisonCommitSchema).max(1_000),
  files: z.array(gitFileChangeSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitCommitActionApplySchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitCommitActionResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  headBefore: gitCommitHashInputSchema,
  headAfter: gitCommitHashInputSchema,
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  operation: gitOperationSummarySchema.nullable(),
});

const gitPathsSchema = z.array(gitRelativePathSchema).min(1).max(1_000);
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("unstage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("discard"), paths: gitPathsSchema }),
  z.object({ type: z.literal("stageAll") }),
  z.object({ type: z.literal("unstageAll") }),
  z.object({ type: z.literal("discardAll") }),
  z.object({
    type: z.literal("commit"),
    message: z.string().trim().min(1).max(10_000),
    all: z.boolean().default(false),
  }),
  z.object({ type: z.literal("pull") }),
  z.object({ type: z.literal("push") }),
  z.object({
    type: z.literal("checkout"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("createBranch"),
    name: z.string().trim().min(1).max(255),
  }),
]);

export const gitActionResultSchema = z.object({
  status: gitStatusSchema,
  output: z.string(),
});

export const gitForcePushPreviewSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.literal(true),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  remote: gitRemoteNameInputSchema,
  localBranch: gitBranchNameInputSchema,
  remoteBranch: gitBranchNameInputSchema,
  localHead: gitCommitHashInputSchema,
  expectedRemoteHead: gitCommitHashInputSchema,
  localCommits: z.array(gitComparisonCommitSchema).max(200),
  localCommitCount: z.number().int().nonnegative(),
  localCommitsTruncated: z.boolean(),
  remoteCommits: z.array(gitComparisonCommitSchema).max(200),
  remoteCommitCount: z.number().int().positive(),
  remoteCommitsTruncated: z.boolean(),
});

export const gitForcePushApplySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type GitCherryPickSelection = z.infer<
  typeof gitCherryPickSelectionSchema
>;
export type GitCommitAction = z.infer<typeof gitCommitActionSchema>;
export type GitOperationSummary = z.infer<typeof gitOperationSummarySchema>;
export type GitManagedOperationType = z.infer<
  typeof gitManagedOperationTypeSchema
>;
export type GitManagedOperationState = z.infer<
  typeof gitManagedOperationStateSchema
>;
export type GitMergeRebaseAction = z.infer<typeof gitMergeRebaseActionSchema>;
export type GitBisectAction = z.infer<typeof gitBisectActionSchema>;
export type GitManagedOperationAction = z.infer<
  typeof gitManagedOperationActionSchema
>;
export type GitInteractiveRebaseTodoAction = z.infer<
  typeof gitInteractiveRebaseTodoActionSchema
>;
export type GitInteractiveRebaseTodoItem = z.infer<
  typeof gitInteractiveRebaseTodoItemSchema
>;
export type GitManagedOperationContext = z.infer<
  typeof gitManagedOperationContextSchema
>;
export type GitManagedOperationWorkerState = z.infer<
  typeof gitManagedOperationWorkerStateSchema
>;
export type GitOperationObservationState = z.infer<
  typeof gitOperationObservationStateSchema
>;
export type GitManagedOperationPreview = z.infer<
  typeof gitManagedOperationPreviewSchema
>;
export type GitManagedOperationStart = z.infer<
  typeof gitManagedOperationStartSchema
>;
export type GitManagedOperationControl = z.infer<
  typeof gitManagedOperationControlSchema
>;
export type GitManagedOperationAmend = z.infer<
  typeof gitManagedOperationAmendSchema
>;
export type GitManagedOperationRecord = z.infer<
  typeof gitManagedOperationRecordSchema
>;
export type GitManagedOperationResponse = z.infer<
  typeof gitManagedOperationResponseSchema
>;
export type GitConflictKind = z.infer<typeof gitConflictKindSchema>;
export type GitConflictStage = z.infer<typeof gitConflictStageSchema>;
export type GitConflictSummary = z.infer<typeof gitConflictSummarySchema>;
export type GitConflictList = z.infer<typeof gitConflictListSchema>;
export type GitConflictDetail = z.infer<typeof gitConflictDetailSchema>;
export type GitConflictResolutionStrategy = z.infer<
  typeof gitConflictResolutionStrategySchema
>;
export type GitConflictResolutionRequest = z.infer<
  typeof gitConflictResolutionRequestSchema
>;
export type GitConflictResolutionPreview = z.infer<
  typeof gitConflictResolutionPreviewSchema
>;
export type GitConflictResolutionApply = z.infer<
  typeof gitConflictResolutionApplySchema
>;
export type GitConflictResolutionResult = z.infer<
  typeof gitConflictResolutionResultSchema
>;
export type GitCommitActionPreview = z.infer<
  typeof gitCommitActionPreviewSchema
>;
export type GitCommitActionApply = z.infer<typeof gitCommitActionApplySchema>;
export type GitCommitActionResult = z.infer<typeof gitCommitActionResultSchema>;
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitForcePushPreview = z.infer<typeof gitForcePushPreviewSchema>;
export type GitForcePushApply = z.infer<typeof gitForcePushApplySchema>;
