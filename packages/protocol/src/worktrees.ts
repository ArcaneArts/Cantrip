import { z } from "zod";

import {
  githubActionsRunSchema,
  githubPullRequestSummarySchema,
} from "./github.js";

import { projectRootKindSchema } from "./project-foundation.js";

export const worktreePolicySchema = z.enum([
  "direct",
  "agent-managed",
  "required-for-writes",
]);
export const worktreeOriginSchema = z.enum([
  "cantrip",
  "agent",
  "user",
  "external",
]);
export const worktreeLifecycleStateSchema = z.enum([
  "creating",
  "ready",
  "missing",
  "prunable",
  "removing",
]);

export const projectWorktreeSummarySchema = z.object({
  id: z.string().min(1),
  projectSourceId: z.string().min(1),
  projectId: z.string().min(1),
  rootKind: projectRootKindSchema.default("git-worktree"),
  workerId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  isPrimary: z.boolean(),
  isDefault: z.boolean(),
  origin: worktreeOriginSchema,
  lifecycleState: worktreeLifecycleStateSchema,
  branch: z.string().min(1).nullable(),
  head: z.string().min(1).nullable(),
  detached: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  lastScannedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectWorktreeListSchema = z.array(projectWorktreeSummarySchema);

export const githubPullRequestCheckoutResultSchema = z.object({
  pullRequest: githubPullRequestSummarySchema,
  worktree: projectWorktreeSummarySchema,
  reused: z.boolean(),
});

export const githubActionsRunCheckoutResultSchema = z.object({
  run: githubActionsRunSchema,
  worktree: projectWorktreeSummarySchema,
  reused: z.boolean(),
});

export type WorktreePolicy = z.infer<typeof worktreePolicySchema>;

export type WorktreeOrigin = z.infer<typeof worktreeOriginSchema>;

export type WorktreeLifecycleState = z.infer<
  typeof worktreeLifecycleStateSchema
>;

export type ProjectWorktreeSummary = z.infer<
  typeof projectWorktreeSummarySchema
>;

export type GithubPullRequestCheckoutResult = z.infer<
  typeof githubPullRequestCheckoutResultSchema
>;

export type GithubActionsRunCheckoutResult = z.infer<
  typeof githubActionsRunCheckoutResultSchema
>;
