import { z } from "zod";
import { repositoryRelativePathSchema } from "./repository-paths.js";

export const gitRefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["head", "local", "remote", "tag"]),
  current: z.boolean(),
});

export const gitCommitSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  parents: z.array(z.string().min(1)),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
  refs: z.array(gitRefSchema),
  isHead: z.boolean(),
});

export const gitCommitPersonSchema = z.object({
  name: z.string().min(1),
  email: z.string(),
  date: z.string().datetime({ offset: true }),
});

export const gitSignatureSchema = z.object({
  status: z.enum([
    "unsigned",
    "valid",
    "valid-unknown",
    "invalid",
    "expired",
    "revoked",
    "unverifiable",
  ]),
  signer: z.string().nullable(),
  key: z.string().nullable(),
  fingerprint: z.string().nullable(),
  format: z.enum(["gpg", "ssh", "x509", "unknown"]).nullable().default(null),
  verification: z
    .enum([
      "available",
      "missing-key",
      "missing-config",
      "missing-tool",
      "error",
      "not-applicable",
    ])
    .default("not-applicable"),
  verificationMessage: z.string().max(10_000).nullable().default(null),
});

export const gitAgentDraftTaskSchema = z.enum([
  "summarize-changes",
  "draft-commit-message",
  "draft-pr-description",
  "review-commit-range",
  "explain-conflicts",
  "summarize-failed-checks",
]);

const gitAgentRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => !value.startsWith("-") && !/[\0\r\n]/u.test(value),
    "Expected a safe Git revision.",
  );

export const gitAgentDraftCreateSchema = z
  .object({
    task: gitAgentDraftTaskSchema,
    modelId: z.string().min(1).max(200).optional(),
    instructions: z.string().trim().max(2_000).nullable().default(null),
    baseRevision: gitAgentRevisionSchema.nullable().default(null),
    headRevision: gitAgentRevisionSchema.nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (
      ["draft-pr-description", "review-commit-range"].includes(value.task) &&
      (!value.baseRevision || !value.headRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "This task requires both base and head revisions.",
      });
    }
    if (value.task === "summarize-failed-checks" && !value.pullRequestNumber) {
      context.addIssue({
        code: "custom",
        message: "This task requires a pull request number.",
      });
    }
  });

export const gitAgentDraftModelOutputSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
});

export const gitAgentDraftResultSchema = z.object({
  generationId: z.string().min(1).max(200),
  task: gitAgentDraftTaskSchema,
  text: z.string().trim().min(1).max(100_000),
  modelId: z.string().min(1).max(200),
  modelName: z.string().min(1).max(500),
  providerName: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200),
  generatedAt: z.iso.datetime(),
});

export const gitRelativePathSchema = repositoryRelativePathSchema;

export const gitCommitFileSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
    "unmerged",
    "unknown",
  ]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitCommitDetailSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(64),
  children: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(10_000),
  parentIndex: z.number().int().nonnegative().nullable(),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  author: gitCommitPersonSchema,
  committer: gitCommitPersonSchema,
  signature: gitSignatureSchema.nullable(),
  refs: z.array(gitRefSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitDiffFileSideSchema = z
  .object({
    kind: z.enum(["missing", "text", "image", "binary"]),
    size: z.number().int().nonnegative().nullable(),
    mimeType: z.string().min(1).max(200).nullable(),
    base64: z.string().max(3_000_000).nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const gitRevisionFileDiffSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
  oldFile: gitDiffFileSideSchema.optional(),
  newFile: gitDiffFileSideSchema.optional(),
});

export const gitRevisionCandidateSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  name: z.string().min(1).max(1_024),
  kind: z.enum(["head", "local", "remote", "tag", "worktree"]),
  current: z.boolean(),
  worktreeId: z.string().min(1).nullable(),
  worktreeName: z.string().min(1).nullable(),
});

export const gitRevisionCandidateListSchema = z
  .array(gitRevisionCandidateSchema)
  .max(20_000);

export const gitComparisonModeSchema = z.enum(["direct", "merge-base"]);

export const gitComparisonCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitComparisonSchema = z.object({
  mode: gitComparisonModeSchema,
  left: z.string().regex(/^[0-9a-f]{40,64}$/u),
  right: z.string().regex(/^[0-9a-f]{40,64}$/u),
  mergeBase: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  diffBase: z.string().regex(/^[0-9a-f]{40,64}$/u),
  leftAhead: z.number().int().nonnegative(),
  rightAhead: z.number().int().nonnegative(),
  leftCommits: z.array(gitComparisonCommitSchema).max(100),
  rightCommits: z.array(gitComparisonCommitSchema).max(100),
  leftCommitsTruncated: z.boolean(),
  rightCommitsTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitHistorySchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  commits: z.array(gitCommitSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitFileHistoryEntrySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitFileHistorySchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  commits: z.array(gitFileHistoryEntrySchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitBlameRangeSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortCommit: z.string().min(1).max(64),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime(),
  summary: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  lines: z.array(z.string()).min(1).max(501),
});

export const gitBlameSchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  ranges: z.array(gitBlameRangeSchema).max(501),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitGraphNodeKindSchema = z.enum([
  "directory",
  "file",
  "symlink",
  "submodule",
]);

export const gitGraphMetricStateSchema = z.enum([
  "pending",
  "ready",
  "deferred",
  "unavailable",
]);

export const gitGraphAnalysisStateSchema = z.object({
  structure: z.literal("ready"),
  lines: gitGraphMetricStateSchema,
  history: gitGraphMetricStateSchema,
  blame: gitGraphMetricStateSchema,
});

const gitGraphNodeIdSchema = z.string().min(1).max(4_200);

export const gitGraphNodeSchema = z.object({
  id: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  parentId: gitGraphNodeIdSchema.nullable(),
  name: z.string().min(1).max(4_096),
  kind: gitGraphNodeKindSchema,
  objectId: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  extension: z.string().max(200).nullable(),
  language: z.string().max(200).nullable(),
});

export const gitGraphSnapshotSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  branch: z.string().nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  rootId: gitGraphNodeIdSchema,
  nodes: z.array(gitGraphNodeSchema).min(1).max(100_000),
  totalNodes: z.number().int().positive(),
  truncated: z.boolean(),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphNodeMetricsSchema = z.object({
  nodeId: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  binary: z.boolean().nullable(),
  commitTouches: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  churn: z.number().int().nonnegative(),
  binaryCommitTouches: z.number().int().nonnegative(),
  firstChangedAt: z.string().datetime({ offset: true }).nullable(),
  lastChangedAt: z.string().datetime({ offset: true }).nullable(),
  dominantAuthorName: z.string().max(500).nullable(),
  dominantAuthorEmail: z.string().max(1_000).nullable(),
  dominantAuthorShare: z.number().min(0).max(1).nullable(),
  averageBlameAgeDays: z.number().nonnegative().nullable(),
});

export const gitGraphMetricsSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  historyScope: z.enum(["current-branch", "none"]),
  renameAware: z.boolean(),
  blameCoverage: z
    .object({
      analyzedFiles: z.number().int().nonnegative(),
      totalFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .nullable()
    .default(null),
  nodes: z.array(gitGraphNodeMetricsSchema).min(1).max(100_000),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphRequestSchema = z.object({
  revision: gitAgentRevisionSchema.default("HEAD"),
  rootPath: gitRelativePathSchema.nullable().default(null),
  maxNodes: z.number().int().min(1).max(100_000).default(100_000),
  includeBlame: z.boolean().default(false),
});

export const gitGraphCommitOverlayRequestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  rootPath: gitRelativePathSchema.nullable().default(null),
});

export const gitGraphCommitOverlayNodeSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: gitCommitFileSchema.shape.status,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  weight: z.number().int().nonnegative(),
  binary: z.boolean(),
  ghost: z.boolean(),
});

export const gitGraphCommitOverlaySchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  nodes: z.array(gitGraphCommitOverlayNodeSchema).max(100_000),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const gitSearchDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const gitCommitSearchQuerySchema = z
  .object({
    message: z.string().trim().min(1).max(1_000).nullable().default(null),
    author: z.string().trim().min(1).max(1_000).nullable().default(null),
    hash: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{4,64}$/u)
      .nullable()
      .default(null),
    dateFrom: gitSearchDateSchema.nullable().default(null),
    dateTo: gitSearchDateSchema.nullable().default(null),
    path: gitRelativePathSchema.nullable().default(null),
    branch: z.string().trim().min(1).max(1_024).nullable().default(null),
    tag: z.string().trim().min(1).max(1_024).nullable().default(null),
  })
  .superRefine((query, context) => {
    if (query.branch && query.tag) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "Search can target a branch or tag, not both.",
      });
    }
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      context.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "Search end date cannot precede its start date.",
      });
    }
    if (!Object.values(query).some(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "At least one commit search filter is required.",
      });
    }
  });

export const gitCommitSearchResultSchema = z.object({
  query: gitCommitSearchQuerySchema,
  commits: z.array(gitCommitSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryCandidateSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  selector: z.string().min(1).max(1_024),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  action: z.string().min(1).max(100),
  subject: z.string().max(10_000),
  explanation: z.string().min(1).max(10_000),
  actorName: z.string().max(1_000).nullable(),
  actorEmail: z.string().max(1_000).nullable(),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
});

export const gitRecoveryCandidateListSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  entries: z.array(gitRecoveryCandidateSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("restoreBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("reset"),
    mode: z.enum(["soft", "mixed", "hard"]),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
]);

export const gitRecoveryPreviewSchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  confirmation: z.string().min(1).max(1_000),
  targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  branchBefore: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  commitsRemoved: z.array(gitComparisonCommitSchema).max(200),
  commitsRemovedTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  status: z.lazy(() => gitStatusSchema),
});

export const gitRecoveryApplySchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.string().min(1).max(1_000),
});

export const gitRecoveryResultSchema = z.object({
  action: gitRecoveryActionSchema,
  output: z.string().max(1_000_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  headBefore: z.string().regex(/^[0-9a-f]{40,64}$/u),
  headAfter: z.string().regex(/^[0-9a-f]{40,64}$/u),
  status: z.lazy(() => gitStatusSchema),
});

export const gitFileChangeSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).nullable(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().min(1),
  upstream: z.string().min(1).nullable(),
});

export const gitStatusSchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  upstream: z.string().min(1).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(gitFileChangeSchema),
  branches: z.array(gitBranchSchema),
});

export const gitDiffScopeSchema = z.enum(["unstaged", "staged"]);

export const gitDiffContextLinesSchema = z.number().int().min(0).max(1_000);

export const gitFileDiffSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable().optional(),
  scope: gitDiffScopeSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean().optional(),
  oldFile: gitDiffFileSideSchema.optional(),
  newFile: gitDiffFileSideSchema.optional(),
});

export const gitPartialPatchOperationSchema = z.enum([
  "stage",
  "unstage",
  "discard",
]);

export const gitPartialPatchHunkSelectionSchema = z.object({
  hunkIndex: z.number().int().nonnegative(),
  lineIndexes: z.array(z.number().int().nonnegative()).max(100_000).nullable(),
});

export const gitPartialPatchRequestSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  hunks: z.array(gitPartialPatchHunkSelectionSchema).min(1).max(10_000),
});

export const gitPartialPatchPreviewSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().min(1).max(2_000_000),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  selectedHunks: z.number().int().positive(),
  selectedLines: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitPartialPatchApplySchema = z.object({
  request: gitPartialPatchRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashFileSchema = z.object({
  path: gitRelativePathSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitStashSummarySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  message: z.string().max(10_000),
  createdAt: z.string().datetime({ offset: true }),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  files: z.array(gitStashFileSchema).max(10_000),
  filesChanged: z.number().int().nonnegative(),
  filesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  includesUntracked: z.boolean(),
});

export const gitStashListSchema = z.object({
  stashes: z.array(gitStashSummarySchema).max(10_000),
  truncated: z.boolean(),
});

export const gitStashCreateSchema = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    includeStaged: z.boolean(),
    includeUnstaged: z.boolean(),
    includeUntracked: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      !value.includeStaged &&
      !value.includeUnstaged &&
      !value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Select at least one change scope.",
      });
    }
    if (
      value.includeStaged &&
      !value.includeUnstaged &&
      value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Git cannot combine staged-only and untracked stash scopes.",
      });
    }
  });

const gitStashIdentitySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
});

export const gitBranchNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\0\r\n]+$/u);

export const gitStashActionSchema = z.discriminatedUnion("type", [
  gitStashIdentitySchema.extend({ type: z.literal("apply") }),
  gitStashIdentitySchema.extend({ type: z.literal("pop") }),
  gitStashIdentitySchema.extend({ type: z.literal("drop") }),
  z.object({ type: z.literal("clear") }),
  gitStashIdentitySchema.extend({
    type: z.literal("branch"),
    branch: gitBranchNameInputSchema,
  }),
]);

export const gitStashActionPreviewSchema = z.object({
  action: gitStashActionSchema,
  stashes: z.array(gitStashSummarySchema).min(1).max(10_000),
  destructive: z.boolean(),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitStashActionApplySchema = z.object({
  action: gitStashActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  stash: gitStashSummarySchema.nullable(),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
  operation: z
    .object({
      type: z.literal("stash"),
      state: z.literal("conflicted"),
      originalHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      sourceRef: z.string().min(1).max(1_024),
      sourceRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      targetRef: z.string().min(1).max(1_024).nullable(),
      targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      pendingCommits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).length(1),
      currentStep: z.literal(1),
      totalSteps: z.literal(1),
      checkpointRef: z.string().min(1).max(1_024),
      conflictedPaths: z.array(gitRelativePathSchema).min(1).max(100_000),
    })
    .nullable()
    .default(null),
});

export const gitStashFileDiffSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  path: gitRelativePathSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
  oldFile: gitDiffFileSideSchema.optional(),
  newFile: gitDiffFileSideSchema.optional(),
});

export const gitBranchCommitSummarySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  subject: z.string().max(100_000),
  authorName: z.string().min(1).max(10_000),
  authoredAt: z.string().datetime({ offset: true }),
});

const gitBranchDisplayNameSchema = z.string().min(1).max(1_000);

export const gitManagedBranchSchema = z.object({
  name: gitBranchDisplayNameSchema,
  fullRef: z.string().min(1).max(1_000),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  upstream: z.string().min(1).max(1_000).nullable(),
  upstreamGone: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergedIntoHead: z.boolean().nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  remoteAvailable: z.boolean(),
  trackingLocalBranches: z.array(gitBranchDisplayNameSchema).max(10_000),
  worktree: z
    .object({
      label: z.string().min(1).max(1_000),
      current: z.boolean(),
    })
    .nullable(),
  lastCommit: gitBranchCommitSummarySchema,
});

export const gitPullStrategySchema = z.object({
  mode: z.enum(["fast-forward-only", "rebase", "merge", "unspecified"]),
  description: z.string().min(1).max(1_000),
});

export const gitBranchListSchema = z.object({
  currentBranch: gitBranchDisplayNameSchema.nullable(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  detached: z.boolean(),
  defaultRemote: z.string().min(1).max(255).nullable(),
  remotes: z.array(z.string().min(1).max(255)).max(1_000),
  pullStrategy: gitPullStrategySchema,
  branches: z.array(gitManagedBranchSchema).max(20_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitRemoteNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);
export const gitRevisionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitBranchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    name: gitBranchNameInputSchema,
    startPoint: gitRevisionInputSchema.nullable(),
    checkout: z.boolean(),
  }),
  z.object({
    type: z.literal("switch"),
    name: gitBranchNameInputSchema,
    kind: z.enum(["local", "remote"]),
  }),
  z.object({
    type: z.literal("publish"),
    name: gitBranchNameInputSchema,
    remote: gitRemoteNameInputSchema,
  }),
  z.object({
    type: z.literal("rename"),
    name: gitBranchNameInputSchema,
    newName: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("deleteLocal"),
    name: gitBranchNameInputSchema,
    force: z.boolean(),
  }),
  z.object({
    type: z.literal("deleteRemote"),
    remote: gitRemoteNameInputSchema,
    name: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("setUpstream"),
    name: gitBranchNameInputSchema,
    upstream: z.string().trim().min(1).max(1_000).nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    prune: z.boolean(),
  }),
]);

export const gitBranchActionPreviewSchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  branch: gitManagedBranchSchema.nullable(),
});

export const gitBranchActionApplySchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitBranchMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  branches: gitBranchListSchema,
});

export const gitRemoteSummarySchema = z.object({
  name: z.string().min(1).max(255),
  fetchUrl: z.string().min(1).max(8_192),
  fetchUrlRedacted: z.boolean(),
  pushUrl: z.string().min(1).max(8_192),
  pushUrlRedacted: z.boolean(),
  defaultFetch: z.boolean(),
  defaultPush: z.boolean(),
});

export const gitRemoteListSchema = z.object({
  remotes: z.array(gitRemoteSummarySchema).max(1_000),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitRemoteActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("edit"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({ type: z.literal("remove"), name: gitRemoteNameInputSchema }),
  z.object({
    type: z.literal("setDefaults"),
    fetchRemote: gitRemoteNameInputSchema.nullable(),
    pushRemote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema,
    prune: z.boolean(),
  }),
]);

export const gitRemoteActionPreviewSchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  remote: gitRemoteSummarySchema.nullable(),
});

export const gitRemoteActionApplySchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitRemoteMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  remotes: gitRemoteListSchema,
});

export const gitSubmoduleSummarySchema = z.object({
  name: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  url: z.string().min(1).max(8_192),
  branch: z.string().min(1).max(1_024).nullable(),
  expectedHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  currentHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  initialized: z.boolean(),
  dirty: z.boolean(),
  nested: z.boolean(),
  state: z.enum(["clean", "uninitialized", "changed", "conflicted", "missing"]),
});

export const gitSubmoduleListSchema = z.object({
  submodules: z.array(gitSubmoduleSummarySchema).max(10_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitSubmoduleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initialize"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("update"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
    remote: z.boolean(),
  }),
  z.object({
    type: z.literal("sync"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("deinitialize"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitSubmoduleActionPreviewSchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  targets: z.array(gitSubmoduleSummarySchema).max(10_000),
});

export const gitSubmoduleActionApplySchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitSubmoduleMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  submodules: gitSubmoduleListSchema,
});

export const gitLfsTrackedPatternSchema = z.object({
  pattern: z.string().min(1).max(4_096),
  source: gitRelativePathSchema,
});

export const gitLfsFileSchema = z.object({
  path: gitRelativePathSchema,
  oid: z.string().regex(/^[0-9a-f]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checkedOut: z.boolean(),
  downloaded: z.boolean(),
  status: z.string().min(1).max(100).nullable(),
});

export const gitLfsLockSchema = z.object({
  id: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  owner: z.string().min(1).max(1_024).nullable(),
  lockedAt: z.string().datetime({ offset: true }).nullable(),
  ours: z.boolean(),
});

export const gitLfsStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).max(1_024).nullable(),
  message: z.string().max(10_000).nullable(),
  patterns: z.array(gitLfsTrackedPatternSchema).max(10_000),
  files: z.array(gitLfsFileSchema).max(10_000),
  filesTruncated: z.boolean(),
  missingObjects: z.number().int().nonnegative().max(10_000),
  pendingPaths: z
    .array(
      z.object({
        path: gitRelativePathSchema,
        status: z.string().min(1).max(100),
      }),
    )
    .max(10_000),
  locks: z.array(gitLfsLockSchema).max(10_000),
  locksTruncated: z.boolean(),
  locksCached: z.boolean(),
  lockError: z.string().max(10_000).nullable(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitLfsPatternInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .regex(/^[^\0\r\n-][^\0\r\n]*$/u);

export const gitLfsActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("install") }),
  z.object({ type: z.literal("track"), pattern: gitLfsPatternInputSchema }),
  z.object({ type: z.literal("untrack"), pattern: gitLfsPatternInputSchema }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    all: z.boolean(),
  }),
  z.object({
    type: z.literal("pull"),
    remote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({ type: z.literal("prune"), verifyRemote: z.boolean() }),
  z.object({ type: z.literal("refreshLocks") }),
  z.object({ type: z.literal("lock"), path: gitRelativePathSchema }),
  z.object({
    type: z.literal("unlock"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitLfsActionPreviewSchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  status: gitLfsStatusSchema,
});

export const gitLfsActionApplySchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitLfsMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  lfs: gitLfsStatusSchema,
});

export const gitTagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitTagSummarySchema = z.object({
  name: z.string().min(1).max(1_000),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetHash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetType: z.enum(["commit", "tree", "blob", "tag", "other"]),
  annotated: z.boolean(),
  subject: z.string().max(100_000),
  taggerName: z.string().min(1).max(10_000).nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  signature: gitSignatureSchema,
  publishedRemotes: z.array(z.string().min(1).max(255)).max(1_000),
});

export const gitTagDetailSchema = gitTagSummarySchema.extend({
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
});

export const gitTagListSchema = z.object({
  tags: z.array(gitTagSummarySchema).max(10_000),
  truncated: z.boolean(),
  remoteChecks: z.array(
    z.object({
      remote: z.string().min(1).max(255),
      available: z.boolean(),
      error: z.string().max(1_000).nullable(),
    }),
  ),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitTagActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("create"),
      name: gitTagNameInputSchema,
      target: gitRevisionInputSchema.nullable(),
      annotated: z.boolean(),
      message: z.string().trim().min(1).max(1_000_000).nullable(),
    }),
    z.object({
      type: z.literal("push"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
    z.object({ type: z.literal("deleteLocal"), name: gitTagNameInputSchema }),
    z.object({
      type: z.literal("deleteRemote"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
  ])
  .superRefine((action, context) => {
    if (action.type !== "create") return;
    if (action.annotated && !action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Annotated tags require a message.",
      });
    }
    if (!action.annotated && action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Lightweight tags do not have a tag message.",
      });
    }
  });

export const gitTagActionPreviewSchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  tag: gitTagSummarySchema.nullable(),
});

export const gitTagActionApplySchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitTagMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  tags: gitTagListSchema,
});

export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitFileHistoryEntry = z.infer<typeof gitFileHistoryEntrySchema>;
export type GitFileHistory = z.infer<typeof gitFileHistorySchema>;
export type GitBlameRange = z.infer<typeof gitBlameRangeSchema>;
export type GitBlame = z.infer<typeof gitBlameSchema>;
export type GitGraphNodeKind = z.infer<typeof gitGraphNodeKindSchema>;
export type GitGraphMetricState = z.infer<typeof gitGraphMetricStateSchema>;
export type GitGraphAnalysisState = z.infer<typeof gitGraphAnalysisStateSchema>;
export type GitGraphNode = z.infer<typeof gitGraphNodeSchema>;
export type GitGraphSnapshot = z.infer<typeof gitGraphSnapshotSchema>;
export type GitGraphNodeMetrics = z.infer<typeof gitGraphNodeMetricsSchema>;
export type GitGraphMetrics = z.infer<typeof gitGraphMetricsSchema>;
export type GitGraphRequest = z.infer<typeof gitGraphRequestSchema>;
export type GitGraphCommitOverlayRequest = z.infer<
  typeof gitGraphCommitOverlayRequestSchema
>;
export type GitGraphCommitOverlayNode = z.infer<
  typeof gitGraphCommitOverlayNodeSchema
>;
export type GitGraphCommitOverlay = z.infer<typeof gitGraphCommitOverlaySchema>;
export type GitCommitSearchQuery = z.infer<typeof gitCommitSearchQuerySchema>;
export type GitCommitSearchResult = z.infer<typeof gitCommitSearchResultSchema>;
export type GitRecoveryCandidate = z.infer<typeof gitRecoveryCandidateSchema>;
export type GitRecoveryCandidateList = z.infer<
  typeof gitRecoveryCandidateListSchema
>;
export type GitRecoveryAction = z.infer<typeof gitRecoveryActionSchema>;
export type GitRecoveryPreview = z.infer<typeof gitRecoveryPreviewSchema>;
export type GitRecoveryApply = z.infer<typeof gitRecoveryApplySchema>;
export type GitRecoveryResult = z.infer<typeof gitRecoveryResultSchema>;
export type GitCommitPerson = z.infer<typeof gitCommitPersonSchema>;
export type GitSignature = z.infer<typeof gitSignatureSchema>;
export type GitAgentDraftTask = z.infer<typeof gitAgentDraftTaskSchema>;
export type GitAgentDraftCreate = z.infer<typeof gitAgentDraftCreateSchema>;
export type GitAgentDraftResult = z.infer<typeof gitAgentDraftResultSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;
export type GitRevisionFileDiff = z.infer<typeof gitRevisionFileDiffSchema>;
export type GitRevisionCandidate = z.infer<typeof gitRevisionCandidateSchema>;
export type GitComparisonMode = z.infer<typeof gitComparisonModeSchema>;
export type GitComparisonCommit = z.infer<typeof gitComparisonCommitSchema>;
export type GitComparison = z.infer<typeof gitComparisonSchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiffScope = z.infer<typeof gitDiffScopeSchema>;
export type GitDiffFileSide = z.infer<typeof gitDiffFileSideSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitPartialPatchOperation = z.infer<
  typeof gitPartialPatchOperationSchema
>;
export type GitPartialPatchRequest = z.infer<
  typeof gitPartialPatchRequestSchema
>;
export type GitPartialPatchPreview = z.infer<
  typeof gitPartialPatchPreviewSchema
>;
export type GitPartialPatchApply = z.infer<typeof gitPartialPatchApplySchema>;
export type GitStashFile = z.infer<typeof gitStashFileSchema>;
export type GitStashSummary = z.infer<typeof gitStashSummarySchema>;
export type GitStashList = z.infer<typeof gitStashListSchema>;
export type GitStashCreate = z.infer<typeof gitStashCreateSchema>;
export type GitStashAction = z.infer<typeof gitStashActionSchema>;
export type GitStashActionPreview = z.infer<typeof gitStashActionPreviewSchema>;
export type GitStashActionApply = z.infer<typeof gitStashActionApplySchema>;
export type GitStashMutationResult = z.infer<
  typeof gitStashMutationResultSchema
>;
export type GitStashFileDiff = z.infer<typeof gitStashFileDiffSchema>;
export type GitBranchCommitSummary = z.infer<
  typeof gitBranchCommitSummarySchema
>;
export type GitManagedBranch = z.infer<typeof gitManagedBranchSchema>;
export type GitPullStrategy = z.infer<typeof gitPullStrategySchema>;
export type GitBranchList = z.infer<typeof gitBranchListSchema>;
export type GitBranchAction = z.infer<typeof gitBranchActionSchema>;
export type GitBranchActionPreview = z.infer<
  typeof gitBranchActionPreviewSchema
>;
export type GitBranchActionApply = z.infer<typeof gitBranchActionApplySchema>;
export type GitBranchMutationResult = z.infer<
  typeof gitBranchMutationResultSchema
>;
export type GitRemoteSummary = z.infer<typeof gitRemoteSummarySchema>;
export type GitRemoteList = z.infer<typeof gitRemoteListSchema>;
export type GitRemoteAction = z.infer<typeof gitRemoteActionSchema>;
export type GitRemoteActionPreview = z.infer<
  typeof gitRemoteActionPreviewSchema
>;
export type GitRemoteActionApply = z.infer<typeof gitRemoteActionApplySchema>;
export type GitRemoteMutationResult = z.infer<
  typeof gitRemoteMutationResultSchema
>;
export type GitSubmoduleSummary = z.infer<typeof gitSubmoduleSummarySchema>;
export type GitSubmoduleList = z.infer<typeof gitSubmoduleListSchema>;
export type GitSubmoduleAction = z.infer<typeof gitSubmoduleActionSchema>;
export type GitSubmoduleActionPreview = z.infer<
  typeof gitSubmoduleActionPreviewSchema
>;
export type GitSubmoduleActionApply = z.infer<
  typeof gitSubmoduleActionApplySchema
>;
export type GitSubmoduleMutationResult = z.infer<
  typeof gitSubmoduleMutationResultSchema
>;
export type GitLfsTrackedPattern = z.infer<typeof gitLfsTrackedPatternSchema>;
export type GitLfsFile = z.infer<typeof gitLfsFileSchema>;
export type GitLfsLock = z.infer<typeof gitLfsLockSchema>;
export type GitLfsStatus = z.infer<typeof gitLfsStatusSchema>;
export type GitLfsAction = z.infer<typeof gitLfsActionSchema>;
export type GitLfsActionPreview = z.infer<typeof gitLfsActionPreviewSchema>;
export type GitLfsActionApply = z.infer<typeof gitLfsActionApplySchema>;
export type GitLfsMutationResult = z.infer<typeof gitLfsMutationResultSchema>;
export type GitTagSummary = z.infer<typeof gitTagSummarySchema>;
export type GitTagDetail = z.infer<typeof gitTagDetailSchema>;
export type GitTagList = z.infer<typeof gitTagListSchema>;
export type GitTagAction = z.infer<typeof gitTagActionSchema>;
export type GitTagActionPreview = z.infer<typeof gitTagActionPreviewSchema>;
export type GitTagActionApply = z.infer<typeof gitTagActionApplySchema>;
export type GitTagMutationResult = z.infer<typeof gitTagMutationResultSchema>;
