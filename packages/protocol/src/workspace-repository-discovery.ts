import { z } from "zod";

import { repositoryRoutingHandleSchema } from "./repository-operation.js";
import { encryptionKeyBytesSchema } from "./encryption.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  gitObjectRevisionSchema,
  projectGithubRoutingRepositorySchema,
} from "./projects.js";

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
  "unsupported",
]);

export const workspaceRepositoryDetectedClassificationSchema =
  workspaceRepositoryCandidateClassificationSchema.exclude([
    "unclassified",
    "unsupported",
  ]);

export const workspaceRepositoryDiscoveredClassificationSchema =
  workspaceRepositoryCandidateClassificationSchema.exclude(["unclassified"]);

export const workspaceRepositoryCandidateDiagnosticCodeSchema = z.enum([
  "origin-invalid",
  "origin-unavailable",
  "github-cli-unavailable",
  "github-api-unavailable",
  "github-api-invalid",
  "github-identity-mismatch",
  "bare-repository",
  "linked-worktree",
]);

function candidateClassificationMetadataIsValid(candidate: {
  classification: z.infer<
    typeof workspaceRepositoryCandidateClassificationSchema
  >;
  diagnosticCode: z.infer<
    typeof workspaceRepositoryCandidateDiagnosticCodeSchema
  > | null;
  github: unknown | null;
  origin: unknown | null;
}): boolean {
  const hasGithub = candidate.github !== null;
  const hasOrigin = candidate.origin !== null;
  const hasDiagnostic = candidate.diagnosticCode !== null;
  const unsupportedDiagnostic =
    candidate.diagnosticCode === "bare-repository" ||
    candidate.diagnosticCode === "linked-worktree";
  return (
    (candidate.classification === "github-accessible" &&
      hasGithub &&
      hasOrigin &&
      !hasDiagnostic) ||
    (candidate.classification === "github-unavailable" &&
      !hasGithub &&
      hasOrigin &&
      hasDiagnostic &&
      !unsupportedDiagnostic) ||
    ((candidate.classification === "unclassified" ||
      candidate.classification === "local-git") &&
      !hasGithub &&
      !unsupportedDiagnostic) ||
    (candidate.classification === "unsupported" &&
      !hasGithub &&
      unsupportedDiagnostic)
  );
}

export const workspaceRepositoryCandidateImportStateSchema = z.enum([
  "pending",
  "queued",
  "importing",
  "imported",
  "blocked",
  "failed",
  "skipped",
]);

export const workspaceRepositoryCandidateConflictSchema = z
  .object({
    kind: z.enum(["checkout", "github"]),
    projectId: z.string().uuid(),
    workspaceId: z.string().min(1),
  })
  .strict();

export const workspaceRepositoryImportErrorCodeSchema = z.enum([
  "worker-offline",
  "capability-missing",
  "repository-unavailable",
  "repository-changed",
  "project-conflict",
  "import-failed",
]);

export const workspaceRepositoryImportErrorSchema = z
  .object({
    code: workspaceRepositoryImportErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

export const workspaceRepositoryCandidateSummarySchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    workspaceId: z.string().min(1),
    workerId: z.string().min(1),
    pathHandle: repositoryRoutingHandleSchema,
    displayHandle: repositoryRoutingHandleSchema,
    originUrlHandle: repositoryRoutingHandleSchema.nullable(),
    github: projectGithubRoutingRepositorySchema.nullable(),
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    classification: workspaceRepositoryCandidateClassificationSchema,
    importState: workspaceRepositoryCandidateImportStateSchema,
    importAttempt: z.number().int().nonnegative().default(0),
    importError: workspaceRepositoryImportErrorSchema.nullable().default(null),
    projectId: z.string().uuid().nullable().default(null),
    conflict: workspaceRepositoryCandidateConflictSchema
      .nullable()
      .default(null),
    diagnosticCode: workspaceRepositoryCandidateDiagnosticCodeSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      !candidateClassificationMetadataIsValid({
        classification: candidate.classification,
        diagnosticCode: candidate.diagnosticCode,
        github: candidate.github,
        origin: candidate.originUrlHandle,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Repository candidate classification metadata is invalid.",
        path: ["classification"],
      });
    }
    const hasImportError = candidate.importError !== null;
    const needsImportError =
      candidate.importState === "blocked" || candidate.importState === "failed";
    if (needsImportError !== hasImportError) {
      context.addIssue({
        code: "custom",
        message: "Repository candidate import error metadata is invalid.",
        path: ["importError"],
      });
    }
    if (candidate.importState !== "pending" && !candidate.projectId) {
      context.addIssue({
        code: "custom",
        message: "Repository candidate import project identity is missing.",
        path: ["projectId"],
      });
    }
  });

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

export const workspaceRepositoryImportCandidateCreateSchema = z
  .object({
    candidateId: z.string().uuid(),
    projectId: z.string().uuid(),
    nameProtection: privateDisplayLabelOpaqueSchema,
    repositoryBlindIndex: encryptionKeyBytesSchema.nullable().default(null),
  })
  .strict();

export const workspaceRepositoryImportStartSchema = z
  .object({
    expectedStateRevision: z.number().int().positive(),
    candidates: z
      .array(workspaceRepositoryImportCandidateCreateSchema)
      .min(1)
      .max(100)
      .refine(
        (candidates) =>
          new Set(candidates.map(({ candidateId }) => candidateId)).size ===
          candidates.length,
        { message: "Repository import candidates must be unique." },
      ),
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

export const workspaceRepositoryImportValidateCommandSchema = z
  .object({
    type: z.literal("workspace.repository-import.validate"),
    candidateId: z.string().uuid(),
    attempt: z.number().int().positive(),
    rootPath: repositoryRoutingHandleSchema,
    path: repositoryRoutingHandleSchema,
    expectedRepositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const workspaceRepositoryImportValidationResultSchema = z
  .object({
    candidateId: z.string().uuid(),
    attempt: z.number().int().positive(),
    path: repositoryRoutingHandleSchema,
    displayPath: repositoryRoutingHandleSchema,
    originUrl: repositoryRoutingHandleSchema.nullable(),
    github: projectGithubRoutingRepositorySchema.nullable(),
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    classification: workspaceRepositoryDetectedClassificationSchema,
    diagnosticCode: workspaceRepositoryCandidateDiagnosticCodeSchema.nullable(),
    branch: z.string().min(1).max(512).nullable(),
    head: gitObjectRevisionSchema.nullable(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      !candidateClassificationMetadataIsValid({
        classification: candidate.classification,
        diagnosticCode: candidate.diagnosticCode,
        github: candidate.github,
        origin: candidate.originUrl,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Repository import classification metadata is invalid.",
        path: ["classification"],
      });
    }
  });

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
            originUrl: repositoryRoutingHandleSchema.nullable(),
            github: projectGithubRoutingRepositorySchema.nullable(),
            repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
            classification: workspaceRepositoryDiscoveredClassificationSchema,
            diagnosticCode:
              workspaceRepositoryCandidateDiagnosticCodeSchema.nullable(),
          })
          .strict()
          .superRefine((candidate, context) => {
            if (
              !candidateClassificationMetadataIsValid({
                classification: candidate.classification,
                diagnosticCode: candidate.diagnosticCode,
                github: candidate.github,
                origin: candidate.originUrl,
              })
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Repository candidate classification metadata is invalid.",
                path: ["classification"],
              });
            }
          }),
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
export type WorkspaceRepositoryDetectedClassification = z.infer<
  typeof workspaceRepositoryDetectedClassificationSchema
>;
export type WorkspaceRepositoryDiscoveredClassification = z.infer<
  typeof workspaceRepositoryDiscoveredClassificationSchema
>;
export type WorkspaceRepositoryCandidateDiagnosticCode = z.infer<
  typeof workspaceRepositoryCandidateDiagnosticCodeSchema
>;
export type WorkspaceRepositoryCandidateImportState = z.infer<
  typeof workspaceRepositoryCandidateImportStateSchema
>;
export type WorkspaceRepositoryCandidateConflict = z.infer<
  typeof workspaceRepositoryCandidateConflictSchema
>;
export type WorkspaceRepositoryImportErrorCode = z.infer<
  typeof workspaceRepositoryImportErrorCodeSchema
>;
export type WorkspaceRepositoryImportError = z.infer<
  typeof workspaceRepositoryImportErrorSchema
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
export type WorkspaceRepositoryImportCandidateCreate = z.infer<
  typeof workspaceRepositoryImportCandidateCreateSchema
>;
export type WorkspaceRepositoryImportStart = z.infer<
  typeof workspaceRepositoryImportStartSchema
>;
export type WorkspaceRepositoryDiscoveryCommand = z.infer<
  typeof workspaceRepositoryDiscoveryCommandSchema
>;
export type WorkspaceRepositoryDiscoveryWorkerResult = z.infer<
  typeof workspaceRepositoryDiscoveryWorkerResultSchema
>;
export type WorkspaceRepositoryImportValidateCommand = z.infer<
  typeof workspaceRepositoryImportValidateCommandSchema
>;
export type WorkspaceRepositoryImportValidationResult = z.infer<
  typeof workspaceRepositoryImportValidationResultSchema
>;
