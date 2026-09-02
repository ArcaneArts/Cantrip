import { z } from "zod";

import { repositoryRoutingHandleSchema } from "./repository-operation.js";

export const workspaceRepositoryDiscoveryJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const workspaceRepositoryDiscoveryErrorCodeSchema = z.enum([
  "worker-offline",
  "capability-missing",
  "root-unavailable",
  "discovery-failed",
]);

export const workspaceRepositoryDiscoveryErrorSchema = z
  .object({
    code: workspaceRepositoryDiscoveryErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

export const workspaceRepositoryDiscoveryCountsSchema = z
  .object({
    candidates: z.number().int().nonnegative(),
    collapsedRepositories: z.number().int().nonnegative(),
    rejectedRepositories: z.number().int().nonnegative(),
    scannedDirectories: z.number().int().nonnegative(),
    scannedEntries: z.number().int().nonnegative(),
    skippedSymlinks: z.number().int().nonnegative(),
    unreadableDirectories: z.number().int().nonnegative(),
  })
  .strict();

export const workspaceRepositoryDiscoveryProgressSchema = z
  .object({
    counts: workspaceRepositoryDiscoveryCountsSchema,
    truncated: z.boolean(),
  })
  .strict();

export const workspaceRepositoryDiscoveryJobSummarySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1),
    workerId: z.string().min(1),
    state: workspaceRepositoryDiscoveryJobStateSchema,
    stateRevision: z.number().int().positive(),
    attempt: z.number().int().nonnegative(),
    depth: z.number().int().min(0).max(16),
    truncated: z.boolean(),
    counts: workspaceRepositoryDiscoveryCountsSchema.nullable(),
    error: workspaceRepositoryDiscoveryErrorSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const workspaceRepositoryCandidateClassificationSchema = z.enum([
  "unclassified",
  "local-git",
  "github-accessible",
  "github-unavailable",
]);

export const workspaceRepositoryCandidateImportStateSchema = z.enum([
  "pending",
  "importing",
  "imported",
  "failed",
  "skipped",
]);

export const workspaceRepositoryCandidateSummarySchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    workspaceId: z.string().min(1),
    workerId: z.string().min(1),
    pathHandle: repositoryRoutingHandleSchema,
    displayHandle: repositoryRoutingHandleSchema,
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    classification: workspaceRepositoryCandidateClassificationSchema,
    importState: workspaceRepositoryCandidateImportStateSchema,
    diagnosticCode: z.string().min(1).max(200).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const workspaceRepositoryDiscoverySnapshotSchema = z
  .object({
    job: workspaceRepositoryDiscoveryJobSummarySchema,
    candidates: z.array(workspaceRepositoryCandidateSummarySchema),
    progress: workspaceRepositoryDiscoveryProgressSchema
      .nullable()
      .default(null),
  })
  .strict();

export const workspaceRepositoryDiscoveryStartSchema = z
  .object({
    expectedStateRevision: z.number().int().positive().optional(),
    depth: z.number().int().min(0).max(16).default(3),
  })
  .strict();

export const workspaceRepositoryDiscoveryCommandSchema = z
  .object({
    type: z.literal("workspace.repositories.discover"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    rootPath: repositoryRoutingHandleSchema,
    depth: z.number().int().min(0).max(16),
  })
  .strict();

export const workspaceRepositoryDiscoveryWorkerResultSchema = z
  .object({
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    candidates: z
      .array(
        z
          .object({
            path: repositoryRoutingHandleSchema,
            displayPath: repositoryRoutingHandleSchema,
            repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          })
          .strict(),
      )
      .max(500),
    counts: workspaceRepositoryDiscoveryCountsSchema,
    truncated: z.boolean(),
  })
  .strict();

export type WorkspaceRepositoryDiscoveryJobState = z.infer<
  typeof workspaceRepositoryDiscoveryJobStateSchema
>;
export type WorkspaceRepositoryDiscoveryErrorCode = z.infer<
  typeof workspaceRepositoryDiscoveryErrorCodeSchema
>;
export type WorkspaceRepositoryDiscoveryError = z.infer<
  typeof workspaceRepositoryDiscoveryErrorSchema
>;
export type WorkspaceRepositoryDiscoveryCounts = z.infer<
  typeof workspaceRepositoryDiscoveryCountsSchema
>;
export type WorkspaceRepositoryDiscoveryProgress = z.infer<
  typeof workspaceRepositoryDiscoveryProgressSchema
>;
export type WorkspaceRepositoryDiscoveryJobSummary = z.infer<
  typeof workspaceRepositoryDiscoveryJobSummarySchema
>;
export type WorkspaceRepositoryCandidateClassification = z.infer<
  typeof workspaceRepositoryCandidateClassificationSchema
>;
export type WorkspaceRepositoryCandidateImportState = z.infer<
  typeof workspaceRepositoryCandidateImportStateSchema
>;
export type WorkspaceRepositoryCandidateSummary = z.infer<
  typeof workspaceRepositoryCandidateSummarySchema
>;
export type WorkspaceRepositoryDiscoverySnapshot = z.infer<
  typeof workspaceRepositoryDiscoverySnapshotSchema
>;
export type WorkspaceRepositoryDiscoveryStart = z.infer<
  typeof workspaceRepositoryDiscoveryStartSchema
>;
export type WorkspaceRepositoryDiscoveryCommand = z.infer<
  typeof workspaceRepositoryDiscoveryCommandSchema
>;
export type WorkspaceRepositoryDiscoveryWorkerResult = z.infer<
  typeof workspaceRepositoryDiscoveryWorkerResultSchema
>;
