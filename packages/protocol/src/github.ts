import { z } from "zod";

export const githubAuthStatusSchema = z.object({
  authenticated: z.boolean(),
  login: z.string().min(1).nullable(),
  source: z.enum(["gh-cli", "token", "none"]),
});

export const githubRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  url: z.url(),
  defaultBranch: z.string().min(1),
  updatedAt: z.string().datetime(),
  imported: z.boolean().default(false),
});

export const githubRepositoryListSchema = z.array(githubRepositorySchema);

const githubRepositorySegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== "..", {
    message: "Repository names cannot be dot path segments.",
  });

export const githubRepositoryOwnerSchema = z.object({
  login: githubRepositorySegmentSchema,
  kind: z.enum(["user", "organization"]),
});

export const githubRepositoryOwnerListSchema = z.array(
  githubRepositoryOwnerSchema,
);

export const githubRepositoryVisibilitySchema = z.enum(["public", "private"]);

export const githubRepositoryCreateSchema = z.object({
  owner: githubRepositorySegmentSchema,
  name: githubRepositorySegmentSchema,
  description: z.string().trim().max(350),
  visibility: githubRepositoryVisibilitySchema,
  initialize: z.enum(["readme", "empty"]).default("readme"),
});

export const githubIssueStateSchema = z.enum(["open", "closed"]);
export const githubIssueKindSchema = z.enum(["issue", "pull-request"]);
export const githubInboxViewSchema = z.enum([
  "all",
  "needs-review",
  "failed-checks",
  "merge-conflicts",
  "approved-ready",
  "stale",
  "assigned-to-me",
  "activity",
]);

export const githubInboxAttentionSchema = z.enum([
  "assigned",
  "mention",
  "review-requested",
  "unread",
  "failed-checks",
  "merge-conflict",
  "approved-ready",
  "stale",
]);

export const githubListCursorSchema = z
  .string()
  .min(1)
  .max(2_000)
  .nullable()
  .default(null);

const githubLoginFilterSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^(?:@me|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/u)
  .nullable()
  .default(null);

export const githubIssueListViewSchema = z.enum([
  "all",
  "assigned-to-me",
  "review-requested",
  "recently-updated",
]);

export const githubPullRequestReviewDecisionSchema = z.enum([
  "approved",
  "changes-requested",
  "review-required",
  "none",
]);

export const githubPullRequestMergeabilitySchema = z.enum([
  "mergeable",
  "conflicting",
  "unknown",
]);

export const githubPullRequestChecksStateSchema = z.enum([
  "success",
  "failure",
  "pending",
  "neutral",
  "none",
  "unknown",
]);

export const githubIssueListFiltersSchema = z.object({
  search: z.string().trim().max(256).default(""),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  author: githubLoginFilterSchema,
  assignee: githubLoginFilterSchema,
  milestone: z.string().trim().min(1).max(100).nullable().default(null),
  view: githubIssueListViewSchema.default("all"),
  draft: z.boolean().nullable().default(null),
  reviewDecision: githubPullRequestReviewDecisionSchema
    .nullable()
    .default(null),
  mergeability: githubPullRequestMergeabilitySchema.nullable().default(null),
  checksState: githubPullRequestChecksStateSchema
    .exclude(["neutral", "none", "unknown"])
    .nullable()
    .default(null),
});

export const githubIssueLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
});

export const githubIssueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: githubIssueStateSchema,
  url: z.url(),
  author: z.string().min(1),
  commentCount: z.number().int().nonnegative(),
  labels: z.array(githubIssueLabelSchema),
  assignees: z.array(z.string().min(1)).max(100).default([]),
  milestone: z.string().min(1).max(1_000).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

export const githubIssueListSchema = z.object({
  kind: z.literal("issue").default("issue"),
  state: githubIssueStateSchema,
  total: z.number().int().nonnegative().nullable(),
  issues: z.array(githubIssueSummarySchema),
  nextCursor: githubListCursorSchema,
});

export const githubIssueCommentSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
  url: z.url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const githubIssueDetailSchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  comments: z.array(githubIssueCommentSchema),
});

export const githubIssueCreateSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(1_000_000).default(""),
});

export const githubIssueCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(65_536),
});

export const githubIssueCloseSchema = z.object({
  comment: z.string().trim().min(1).max(65_536).nullable().default(null),
});

export const githubPullRequestCreateSchema = z
  .object({
    base: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Base branch cannot contain control characters.",
      }),
    head: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: "Head branch cannot contain control characters.",
      }),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(1_000_000).default(""),
    draft: z.boolean().default(false),
    labels: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    reviewers: z
      .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u))
      .max(100)
      .default([]),
    linkedIssueNumbers: z
      .array(z.number().int().positive())
      .max(100)
      .default([]),
  })
  .superRefine((request, context) => {
    if (request.base === request.head) {
      context.addIssue({
        code: "custom",
        path: ["head"],
        message: "Pull request head and base branches must differ.",
      });
    }
  });

export const githubPullRequestSummarySchema = githubIssueSummarySchema.extend({
  body: z.string().nullable(),
  draft: z.boolean(),
  merged: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  mergeable: z.boolean().nullable().default(null),
  reviewDecision: githubPullRequestReviewDecisionSchema
    .or(z.literal("reviewed"))
    .default("none"),
  checksState: githubPullRequestChecksStateSchema.default("unknown"),
});

export const githubPullRequestListSchema = z.object({
  state: githubIssueStateSchema,
  total: z.number().int().nonnegative().nullable(),
  pullRequests: z.array(githubPullRequestSummarySchema),
  nextCursor: githubListCursorSchema,
});

export const githubInboxPullRequestStateSchema = z.object({
  draft: z.boolean(),
  headRef: z.string().min(1),
  baseRef: z.string().min(1),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  reviewDecision: z.enum([
    "approved",
    "changes-requested",
    "review-required",
    "none",
  ]),
  checksState: z.enum(["success", "failure", "pending", "neutral", "none"]),
});

export const githubInboxItemSchema = githubIssueSummarySchema.extend({
  kind: githubIssueKindSchema,
  assignees: z.array(z.string().min(1)).max(100),
  attention: z.array(githubInboxAttentionSchema).max(8),
  pullRequest: githubInboxPullRequestStateSchema.nullable(),
});

export const githubInboxListSchema = z.object({
  kind: githubIssueKindSchema,
  state: githubIssueStateSchema,
  view: githubInboxViewSchema,
  total: z.number().int().nonnegative().nullable(),
  items: z.array(githubInboxItemSchema).max(100),
  nextCursor: z.string().min(1).max(2_000).nullable(),
  viewerLogin: z.string().min(1),
  activityAvailable: z.boolean(),
});

export const githubPullRequestCreateResultSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
});

export const githubPullRequestCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  shortSha: z.string().regex(/^[0-9a-f]{7,12}$/u),
  message: z.string().max(1_000_000),
  author: z.string().min(1).max(1_000),
  authoredAt: z.string().datetime().nullable(),
  url: z.url(),
});

export const githubPullRequestFileSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/u),
  path: z.string().min(1).max(8_192),
  previousPath: z.string().min(1).max(8_192).nullable(),
  status: z.string().min(1).max(64),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  blobUrl: z.url(),
  rawUrl: z.url().nullable(),
  patch: z.string().max(1_000_000).nullable(),
  patchTruncated: z.boolean(),
});

export const githubPullRequestCheckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(1_000),
  source: z.enum(["check-run", "commit-status"]),
  status: z.enum(["queued", "in-progress", "completed"]),
  conclusion: z.string().min(1).max(100).nullable(),
  url: z.url().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  summary: z.string().max(100_000).nullable(),
});

export const githubPullRequestReviewSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  state: z.enum([
    "approved",
    "changes-requested",
    "commented",
    "dismissed",
    "pending",
  ]),
  body: z.string().max(1_000_000),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  submittedAt: z.string().datetime().nullable(),
  url: z.url().nullable(),
});

export const githubPullRequestReviewCommentSchema = z.object({
  id: z.number().int().positive(),
  reviewId: z.number().int().positive().nullable(),
  author: z.string().min(1),
  body: z.string().max(1_000_000),
  url: z.url(),
  path: z.string().min(1).max(8_192),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  startLine: z.number().int().positive().nullable(),
  startSide: z.enum(["LEFT", "RIGHT"]).nullable(),
  diffHunk: z.string().max(100_000),
  inReplyToId: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const githubPullRequestReviewThreadSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).max(8_192),
  line: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  resolved: z.boolean().nullable(),
  comments: z.array(githubPullRequestReviewCommentSchema).min(1).max(100),
});

const githubPullRequestReviewPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === ""),
    { message: "Review path must be a repository-relative file path." },
  );

export const githubPullRequestReviewSubmitSchema = z
  .object({
    event: z.enum(["approve", "request-changes"]),
    body: z.string().trim().max(65_536).default(""),
  })
  .superRefine((request, context) => {
    if (request.event === "request-changes" && !request.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Requesting changes requires an explanation.",
      });
    }
  });

export const githubPullRequestInlineCommentCreateSchema = z
  .object({
    body: z.string().trim().min(1).max(65_536),
    path: githubPullRequestReviewPathSchema,
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]),
    startLine: z.number().int().positive().nullable().default(null),
    startSide: z.enum(["LEFT", "RIGHT"]).nullable().default(null),
  })
  .superRefine((request, context) => {
    if ((request.startLine === null) !== (request.startSide === null)) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "A multi-line comment requires both start line and side.",
      });
    }
    if (request.startLine !== null && request.startLine > request.line) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "Review start line cannot be after the end line.",
      });
    }
  });

export const githubPullRequestReviewActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("comment"),
      body: githubIssueCommentCreateSchema.shape.body,
    }),
    z.object({
      type: z.literal("submit-review"),
      review: githubPullRequestReviewSubmitSchema,
    }),
    z.object({
      type: z.literal("inline-comment"),
      comment: githubPullRequestInlineCommentCreateSchema,
    }),
    z.object({
      type: z.literal("reply"),
      commentId: z.number().int().positive(),
      body: githubIssueCommentCreateSchema.shape.body,
    }),
  ],
);

export const githubPullRequestLifecycleActionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("close") }),
    z.object({ type: z.literal("reopen") }),
    z.object({ type: z.literal("mark-ready") }),
    z.object({
      type: z.literal("merge"),
      method: z.enum(["merge", "squash", "rebase"]),
      commitTitle: z.string().trim().min(1).max(256).nullable().default(null),
      commitMessage: z
        .string()
        .trim()
        .min(1)
        .max(1_000_000)
        .nullable()
        .default(null),
    }),
  ],
);

export const githubPullRequestLifecyclePreviewSchema = z.object({
  action: githubPullRequestLifecycleActionSchema,
  number: z.number().int().positive(),
  title: z.string().min(1).max(10_000),
  state: githubIssueStateSchema,
  draft: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().min(1).max(100),
  checksState: githubPullRequestChecksStateSchema,
  reviewDecision: z.enum([
    "approved",
    "changes-requested",
    "review-required",
    "reviewed",
    "none",
    "unknown",
  ]),
  destructive: z.boolean(),
  confirmationPhrase: z.string().min(1).max(100).nullable(),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const githubPullRequestLifecycleApplySchema = z.object({
  action: githubPullRequestLifecycleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.string().max(100).default(""),
});

export const githubPullRequestCheckoutPreparedSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  branch: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(200),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  remote: z.string().trim().min(1).max(255),
});

export const githubPullRequestDataWarningSchema = z.object({
  section: z.enum([
    "conversation",
    "reviews",
    "review-threads",
    "files",
    "commits",
    "checks",
  ]),
  message: z.string().min(1).max(1_000),
});

export const githubPullRequestOverviewSchema =
  githubPullRequestSummarySchema.extend({
    comments: z.array(githubIssueCommentSchema).max(100),
    commentsTruncated: z.boolean(),
    requestedReviewers: z.array(z.string().min(1)).max(100),
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().min(1).max(100),
    reviewDecision: z.enum([
      "approved",
      "changes-requested",
      "review-required",
      "reviewed",
      "none",
      "unknown",
    ]),
    checksState: githubPullRequestChecksStateSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    commitCount: z.number().int().nonnegative(),
    reviews: z.array(githubPullRequestReviewSchema).max(100),
    reviewsTruncated: z.boolean(),
    reviewThreads: z.array(githubPullRequestReviewThreadSchema).max(100),
    reviewThreadsTruncated: z.boolean(),
    warnings: z.array(githubPullRequestDataWarningSchema).max(20).default([]),
  });

export const githubPullRequestFilesSchema = z.object({
  files: z.array(githubPullRequestFileSchema).max(100),
  filesTruncated: z.boolean(),
  warnings: z.array(githubPullRequestDataWarningSchema).max(20).default([]),
});

export const githubPullRequestCommitsSchema = z.object({
  commits: z.array(githubPullRequestCommitSchema).max(100),
  commitsTruncated: z.boolean(),
  warnings: z.array(githubPullRequestDataWarningSchema).max(20).default([]),
});

export const githubPullRequestChecksSchema = z.object({
  checks: z.array(githubPullRequestCheckSchema).max(200),
  checksTruncated: z.boolean(),
  checksState: githubPullRequestChecksStateSchema,
  warnings: z.array(githubPullRequestDataWarningSchema).max(20).default([]),
});

export const githubPullRequestDetailSchema =
  githubPullRequestOverviewSchema.extend({
    commits: githubPullRequestCommitsSchema.shape.commits,
    commitsTruncated: githubPullRequestCommitsSchema.shape.commitsTruncated,
    files: githubPullRequestFilesSchema.shape.files,
    filesTruncated: githubPullRequestFilesSchema.shape.filesTruncated,
    checks: githubPullRequestChecksSchema.shape.checks,
    checksTruncated: githubPullRequestChecksSchema.shape.checksTruncated,
  });

export const githubActionsStatusSchema = z.enum([
  "queued",
  "in-progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);

export const githubActionsWorkflowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(1_000),
  path: z.string().min(1).max(8_192),
  state: z.string().min(1).max(100),
  url: z.url(),
  badgeUrl: z.url().nullable(),
});

export const githubActionsRunSchema = z.object({
  id: z.number().int().positive(),
  workflowId: z.number().int().positive(),
  name: z.string().min(1).max(1_000),
  displayTitle: z.string().min(1).max(10_000),
  event: z.string().min(1).max(100),
  status: githubActionsStatusSchema,
  conclusion: z.string().min(1).max(100).nullable(),
  headBranch: z.string().min(1).max(1_000).nullable(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  pullRequestNumber: z.number().int().positive().nullable(),
  runNumber: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  actor: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  url: z.url(),
});

export const githubActionsRunnerSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(1_000),
  os: z.string().min(1).max(100),
  status: z.enum(["online", "offline"]),
  busy: z.boolean(),
  labels: z.array(z.string().min(1).max(100)).max(100),
});

export const githubActionsOverviewSchema = z.object({
  workflows: z.array(githubActionsWorkflowSchema).max(100),
  workflowsTruncated: z.boolean(),
  runs: z.array(githubActionsRunSchema).max(100),
  totalRunCount: z.number().int().nonnegative(),
  nextPage: z.number().int().positive().nullable(),
  runners: z.array(githubActionsRunnerSchema).max(100),
  runnerAccess: z.enum(["available", "unavailable"]),
  warnings: z.array(z.string().min(1).max(2_000)).max(20),
});

export const githubActionsStepSchema = z.object({
  number: z.number().int().nonnegative(),
  name: z.string().min(1).max(1_000),
  status: githubActionsStatusSchema,
  conclusion: z.string().min(1).max(100).nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const githubActionsJobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(1_000),
  status: githubActionsStatusSchema,
  conclusion: z.string().min(1).max(100).nullable(),
  url: z.url(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  runnerName: z.string().min(1).max(1_000).nullable(),
  runnerGroupName: z.string().min(1).max(1_000).nullable(),
  steps: z.array(githubActionsStepSchema).max(100),
  stepsTruncated: z.boolean(),
});

export const githubActionsArtifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(1_000),
  sizeInBytes: z.number().int().nonnegative(),
  expired: z.boolean(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  url: z.url(),
  testReport: z.boolean(),
});

export const githubActionsRunDetailSchema = z.object({
  run: githubActionsRunSchema,
  jobs: z.array(githubActionsJobSchema).max(100),
  jobsTruncated: z.boolean(),
  artifacts: z.array(githubActionsArtifactSchema).max(100),
  artifactsTruncated: z.boolean(),
  warnings: z.array(z.string().min(1).max(2_000)).max(20),
});

export const githubActionsRunLogsSchema = z.object({
  runId: z.number().int().positive(),
  jobId: z.number().int().positive().nullable(),
  available: z.boolean(),
  text: z.string().max(1_000_000),
  truncated: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const githubActionsWorkflowDispatchSchema = z
  .object({
    workflowId: z.number().int().positive(),
    ref: z.string().trim().min(1).max(1_000),
    inputs: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u),
        z.string().max(10_000),
      )
      .default({}),
  })
  .refine((value) => Object.keys(value.inputs).length <= 50, {
    message: "A workflow dispatch can contain at most 50 inputs.",
    path: ["inputs"],
  });

export const githubActionsRunActionSchema = z.object({
  runId: z.number().int().positive(),
  action: z.enum(["cancel", "rerun", "rerun-failed"]),
});

export const githubActionsMutationResultSchema = z.object({
  accepted: z.literal(true),
  runId: z.number().int().positive().nullable(),
  workflowId: z.number().int().positive().nullable(),
  action: z.enum(["dispatch", "cancel", "rerun", "rerun-failed"]),
  acceptedAt: z.string().datetime(),
});

export const githubActionsRunCheckoutPreparedSchema = z.object({
  run: githubActionsRunSchema,
  branch: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(200),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  remote: z.string().trim().min(1).max(255),
});

export const githubReleaseSummarySchema = z.object({
  id: z.number().int().positive(),
  tagName: z.string().min(1).max(1_000),
  name: z.string().min(1).max(10_000),
  body: z.string().max(1_000_000),
  url: z.url(),
  author: z.string().min(1),
  draft: z.boolean(),
  prerelease: z.boolean(),
  createdAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});

export const githubReleaseListSchema = z.object({
  releases: z.array(githubReleaseSummarySchema).max(100),
  truncated: z.boolean(),
});

export const githubReleaseCreateSchema = z.object({
  tagName: z.string().trim().min(1).max(1_000),
  name: z.string().trim().min(1).max(10_000),
  body: z.string().max(1_000_000),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export type GithubAuthStatus = z.infer<typeof githubAuthStatusSchema>;

export type GithubRepository = z.infer<typeof githubRepositorySchema>;

export type GithubRepositoryOwner = z.infer<typeof githubRepositoryOwnerSchema>;

export type GithubRepositoryVisibility = z.infer<
  typeof githubRepositoryVisibilitySchema
>;

export type GithubRepositoryCreate = z.infer<
  typeof githubRepositoryCreateSchema
>;

export type GithubIssueState = z.infer<typeof githubIssueStateSchema>;

export type GithubIssueKind = z.infer<typeof githubIssueKindSchema>;

export type GithubInboxView = z.infer<typeof githubInboxViewSchema>;

export type GithubInboxAttention = z.infer<typeof githubInboxAttentionSchema>;

export type GithubInboxItem = z.infer<typeof githubInboxItemSchema>;

export type GithubInboxList = z.infer<typeof githubInboxListSchema>;

export type GithubIssueListFilters = z.infer<
  typeof githubIssueListFiltersSchema
>;

export type GithubIssueSummary = z.infer<typeof githubIssueSummarySchema>;

export type GithubIssueList = z.infer<typeof githubIssueListSchema>;

export type GithubPullRequestList = z.infer<typeof githubPullRequestListSchema>;

export type GithubIssueComment = z.infer<typeof githubIssueCommentSchema>;

export type GithubIssueDetail = z.infer<typeof githubIssueDetailSchema>;

export type GithubIssueCreate = z.infer<typeof githubIssueCreateSchema>;

export type GithubPullRequestCreate = z.infer<
  typeof githubPullRequestCreateSchema
>;

export type GithubPullRequestSummary = z.infer<
  typeof githubPullRequestSummarySchema
>;

export type GithubPullRequestOverview = z.infer<
  typeof githubPullRequestOverviewSchema
>;

export type GithubPullRequestFiles = z.infer<
  typeof githubPullRequestFilesSchema
>;

export type GithubPullRequestCommits = z.infer<
  typeof githubPullRequestCommitsSchema
>;

export type GithubPullRequestChecks = z.infer<
  typeof githubPullRequestChecksSchema
>;

export type GithubPullRequestCreateResult = z.infer<
  typeof githubPullRequestCreateResultSchema
>;

export type GithubPullRequestCommit = z.infer<
  typeof githubPullRequestCommitSchema
>;

export type GithubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>;

export type GithubPullRequestCheck = z.infer<
  typeof githubPullRequestCheckSchema
>;

export type GithubPullRequestReview = z.infer<
  typeof githubPullRequestReviewSchema
>;

export type GithubPullRequestReviewComment = z.infer<
  typeof githubPullRequestReviewCommentSchema
>;

export type GithubPullRequestReviewThread = z.infer<
  typeof githubPullRequestReviewThreadSchema
>;

export type GithubPullRequestReviewSubmit = z.infer<
  typeof githubPullRequestReviewSubmitSchema
>;

export type GithubPullRequestInlineCommentCreate = z.infer<
  typeof githubPullRequestInlineCommentCreateSchema
>;

export type GithubPullRequestReviewAction = z.infer<
  typeof githubPullRequestReviewActionSchema
>;

export type GithubPullRequestLifecycleAction = z.infer<
  typeof githubPullRequestLifecycleActionSchema
>;

export type GithubPullRequestLifecyclePreview = z.infer<
  typeof githubPullRequestLifecyclePreviewSchema
>;

export type GithubPullRequestLifecycleApply = z.infer<
  typeof githubPullRequestLifecycleApplySchema
>;

export type GithubPullRequestCheckoutPrepared = z.infer<
  typeof githubPullRequestCheckoutPreparedSchema
>;

export type GithubPullRequestDetail = z.infer<
  typeof githubPullRequestDetailSchema
>;

export type GithubActionsStatus = z.infer<typeof githubActionsStatusSchema>;

export type GithubActionsWorkflow = z.infer<typeof githubActionsWorkflowSchema>;

export type GithubActionsRun = z.infer<typeof githubActionsRunSchema>;

export type GithubActionsRunner = z.infer<typeof githubActionsRunnerSchema>;

export type GithubActionsOverview = z.infer<typeof githubActionsOverviewSchema>;

export type GithubActionsStep = z.infer<typeof githubActionsStepSchema>;

export type GithubActionsJob = z.infer<typeof githubActionsJobSchema>;

export type GithubActionsArtifact = z.infer<typeof githubActionsArtifactSchema>;

export type GithubActionsRunDetail = z.infer<
  typeof githubActionsRunDetailSchema
>;

export type GithubActionsRunLogs = z.infer<typeof githubActionsRunLogsSchema>;

export type GithubActionsWorkflowDispatch = z.infer<
  typeof githubActionsWorkflowDispatchSchema
>;

export type GithubActionsRunAction = z.infer<
  typeof githubActionsRunActionSchema
>;

export type GithubActionsMutationResult = z.infer<
  typeof githubActionsMutationResultSchema
>;

export type GithubActionsRunCheckoutPrepared = z.infer<
  typeof githubActionsRunCheckoutPreparedSchema
>;

export type GithubReleaseSummary = z.infer<typeof githubReleaseSummarySchema>;

export type GithubReleaseList = z.infer<typeof githubReleaseListSchema>;

export type GithubReleaseCreate = z.infer<typeof githubReleaseCreateSchema>;
