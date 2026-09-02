import { randomUUID } from "node:crypto";

import {
  workspaceRepositoryCandidateClassificationSchema,
  workspaceRepositoryCandidateDiagnosticCodeSchema,
  workspaceRepositoryCandidateSummarySchema,
  workspaceRepositoryDiscoveryCountsSchema,
  workspaceRepositoryDiscoveryJobSummarySchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  type WorkspaceRepositoryCandidateClassification,
  type WorkspaceRepositoryCandidateConflict,
  type WorkspaceRepositoryDiscoveryCounts,
  type WorkspaceRepositoryDiscoveryError,
  type WorkspaceRepositoryDiscoveryJobSummary,
  type WorkspaceRepositoryDiscoverySnapshot,
  type WorkspaceRepositoryImportCandidateCreate,
  type WorkspaceRepositoryImportError,
  type WorkspaceRepositoryImportValidationResult,
  type PrivateDisplayLabelOpaque,
} from "@cantrip/protocol";
import { repositoryRoutingHandleSchema } from "@cantrip/protocol/repository-operation";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type JobRow = typeof schema.workspaceRepositoryDiscoveryJobs.$inferSelect;
type CandidateRow = typeof schema.workspaceRepositoryCandidates.$inferSelect;

export const WORKSPACE_REPOSITORY_DISCOVERY_JOB_LEASE_MS = 2 * 60_000;
export const WORKSPACE_REPOSITORY_IMPORT_LEASE_MS = 2 * 60_000;

export class WorkspaceRepositoryDiscoveryInvariantError extends Error {}
export class WorkspaceRepositoryDiscoveryStaleAttemptError extends Error {}
export class WorkspaceRepositoryImportStaleAttemptError extends Error {}

export interface ClaimedWorkspaceRepositoryDiscoveryJob {
  commandId: string;
  job: WorkspaceRepositoryDiscoveryJobSummary;
  ownerId: string;
  rootPathHandle: string;
}

export interface DiscoveredWorkspaceRepositoryCandidate {
  classification?: WorkspaceRepositoryCandidateClassification;
  diagnosticCode?: string | null;
  displayHandle: string;
  originUrlHandle?: string | null;
  github?: {
    repositoryId: string;
    nameWithOwner: string;
    url: string;
  } | null;
  pathHandle: string;
  repositoryFingerprint: string;
}

export interface ClaimedWorkspaceRepositoryImport {
  attempt: number;
  candidateId: string;
  commandId: string;
  expectedRepositoryFingerprint: string;
  nameProtection: PrivateDisplayLabelOpaque;
  ownerId: string;
  pathHandle: string;
  projectId: string;
  repositoryBlindIndex: string | null;
  rootPathHandle: string;
  workerId: string;
  workspaceId: string;
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function counts(row: JobRow): WorkspaceRepositoryDiscoveryCounts | null {
  if (row.candidateCount === null) return null;
  return workspaceRepositoryDiscoveryCountsSchema.parse({
    candidates: row.candidateCount,
    collapsedRepositories: row.collapsedRepositoryCount,
    rejectedRepositories: row.rejectedRepositoryCount,
    scannedDirectories: row.scannedDirectoryCount,
    scannedEntries: row.scannedEntryCount,
    skippedSymlinks: row.skippedSymlinkCount,
    unreadableDirectories: row.unreadableDirectoryCount,
  });
}

function toJob(row: JobRow): WorkspaceRepositoryDiscoveryJobSummary {
  return workspaceRepositoryDiscoveryJobSummarySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    workerId: row.workerId,
    state: row.state,
    stateRevision: row.stateRevision,
    attempt: row.attempt,
    depth: row.depth,
    diagnosticCode: row.truncated ? "scan-truncated" : null,
    truncated: row.truncated,
    counts: counts(row),
    error: row.lastErrorCode
      ? { code: row.lastErrorCode, retryable: row.errorRetryable ?? false }
      : null,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
    startedAt: row.startedAt ? toISOString(row.startedAt) : null,
    completedAt: row.completedAt ? toISOString(row.completedAt) : null,
  });
}

function toCandidate(
  row: CandidateRow,
  conflict: WorkspaceRepositoryCandidateConflict | null = null,
) {
  return workspaceRepositoryCandidateSummarySchema.parse({
    id: row.id,
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    workerId: row.workerId,
    pathHandle: row.protectedPathHandle,
    displayHandle: row.protectedDisplayHandle,
    originUrlHandle: row.protectedOriginUrlHandle,
    github:
      row.protectedGithubRepositoryIdHandle &&
      row.protectedGithubNameWithOwnerHandle &&
      row.protectedGithubUrlHandle
        ? {
            repositoryId: row.protectedGithubRepositoryIdHandle,
            nameWithOwner: row.protectedGithubNameWithOwnerHandle,
            url: row.protectedGithubUrlHandle,
          }
        : null,
    repositoryFingerprint: row.repositoryFingerprint,
    classification: row.classification,
    importState: row.importState,
    importAttempt: row.importAttempt,
    importError: row.importErrorCode
      ? {
          code: row.importErrorCode,
          retryable: row.importErrorRetryable ?? false,
        }
      : null,
    projectId: row.importProjectId,
    conflict,
    diagnosticCode: row.diagnosticCode,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

export class WorkspaceRepositoryDiscoveryJobRepository {
  constructor(private readonly database: Database) {}

  async getSnapshot(
    ownerId: string,
    workspaceId: string,
  ): Promise<WorkspaceRepositoryDiscoverySnapshot | null> {
    const jobs = await this.database
      .select()
      .from(schema.workspaceRepositoryDiscoveryJobs)
      .where(
        and(
          eq(schema.workspaceRepositoryDiscoveryJobs.ownerId, ownerId),
          eq(schema.workspaceRepositoryDiscoveryJobs.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    const job = jobs[0];
    if (!job) return null;
    const candidates = await this.database
      .select()
      .from(schema.workspaceRepositoryCandidates)
      .where(
        and(
          eq(schema.workspaceRepositoryCandidates.ownerId, ownerId),
          eq(schema.workspaceRepositoryCandidates.workspaceId, workspaceId),
        ),
      )
      .orderBy(asc(schema.workspaceRepositoryCandidates.createdAt));
    const fingerprints = candidates.map(
      ({ repositoryFingerprint }) => repositoryFingerprint,
    );
    const githubRepositoryIds = candidates.flatMap(
      ({ protectedGithubRepositoryIdHandle }) =>
        protectedGithubRepositoryIdHandle
          ? [protectedGithubRepositoryIdHandle]
          : [],
    );
    const [checkoutConflicts, githubConflicts] = await Promise.all([
      fingerprints.length
        ? this.database
            .select({
              projectId: schema.projects.id,
              repositoryFingerprint:
                schema.projectSources.repositoryFingerprint,
              workspaceId: schema.projectWorkspaceMemberships.workspaceId,
            })
            .from(schema.projectSources)
            .innerJoin(
              schema.projects,
              and(
                eq(schema.projects.id, schema.projectSources.projectId),
                eq(schema.projects.ownerId, ownerId),
              ),
            )
            .innerJoin(
              schema.projectWorkspaceMemberships,
              eq(
                schema.projectWorkspaceMemberships.projectId,
                schema.projects.id,
              ),
            )
            .where(
              and(
                isNull(schema.projectSources.removedAt),
                eq(schema.projectSources.workerId, job.workerId),
                inArray(
                  schema.projectSources.repositoryFingerprint,
                  fingerprints,
                ),
              ),
            )
            .orderBy(asc(schema.projectSources.createdAt))
        : Promise.resolve([]),
      githubRepositoryIds.length
        ? this.database
            .select({
              projectId: schema.projects.id,
              repositoryId: schema.projects.githubRepositoryId,
              workspaceId: schema.projectWorkspaceMemberships.workspaceId,
            })
            .from(schema.projects)
            .innerJoin(
              schema.projectWorkspaceMemberships,
              eq(
                schema.projectWorkspaceMemberships.projectId,
                schema.projects.id,
              ),
            )
            .where(
              and(
                eq(schema.projects.ownerId, ownerId),
                inArray(
                  schema.projects.githubRepositoryId,
                  githubRepositoryIds,
                ),
              ),
            )
            .orderBy(asc(schema.projects.createdAt))
        : Promise.resolve([]),
    ]);
    const checkoutConflictByFingerprint = new Map(
      checkoutConflicts.flatMap((conflict) =>
        conflict.repositoryFingerprint
          ? [[conflict.repositoryFingerprint, conflict] as const]
          : [],
      ),
    );
    const githubConflictById = new Map(
      githubConflicts.flatMap((conflict) =>
        conflict.repositoryId
          ? [[conflict.repositoryId, conflict] as const]
          : [],
      ),
    );
    return workspaceRepositoryDiscoverySnapshotSchema.parse({
      job: toJob(job),
      candidates: candidates.map((candidate) => {
        const checkout = checkoutConflictByFingerprint.get(
          candidate.repositoryFingerprint,
        );
        const github = candidate.protectedGithubRepositoryIdHandle
          ? githubConflictById.get(candidate.protectedGithubRepositoryIdHandle)
          : undefined;
        return toCandidate(
          candidate,
          checkout
            ? {
                code: "duplicate-checkout",
                kind: "checkout",
                projectId: checkout.projectId,
                workspaceId: checkout.workspaceId,
              }
            : github
              ? {
                  code: "duplicate-github",
                  kind: "github",
                  projectId: github.projectId,
                  workspaceId: github.workspaceId,
                }
              : null,
        );
      }),
    });
  }

  async queueImports(
    ownerId: string,
    workspaceId: string,
    input: {
      candidates: WorkspaceRepositoryImportCandidateCreate[];
      expectedStateRevision: number;
    },
  ): Promise<WorkspaceRepositoryDiscoverySnapshot | null> {
    const now = new Date();
    const queued = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(schema.workspaceRepositoryDiscoveryJobs)
        .where(
          and(
            eq(schema.workspaceRepositoryDiscoveryJobs.ownerId, ownerId),
            eq(
              schema.workspaceRepositoryDiscoveryJobs.workspaceId,
              workspaceId,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const job = jobs[0];
      if (
        !job ||
        job.state !== "succeeded" ||
        job.stateRevision !== input.expectedStateRevision
      ) {
        return false;
      }
      const ids = input.candidates.map(({ candidateId }) => candidateId);
      const rows = await transaction
        .select()
        .from(schema.workspaceRepositoryCandidates)
        .where(
          and(
            eq(schema.workspaceRepositoryCandidates.ownerId, ownerId),
            eq(schema.workspaceRepositoryCandidates.workspaceId, workspaceId),
            eq(schema.workspaceRepositoryCandidates.jobId, job.id),
            inArray(schema.workspaceRepositoryCandidates.id, ids),
          ),
        )
        .for("update");
      if (rows.length !== ids.length) {
        throw new WorkspaceRepositoryDiscoveryInvariantError(
          "Repository import referenced an unknown discovery candidate.",
        );
      }
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      for (const requested of input.candidates) {
        const candidate = rowsById.get(requested.candidateId)!;
        if (
          candidate.classification === "github-accessible" &&
          !requested.repositoryBlindIndex
        ) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "GitHub repository import requires a protected identity index.",
          );
        }
        if (
          candidate.classification === "unclassified" ||
          candidate.classification === "unsupported"
        ) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "This repository candidate is not eligible for automatic import.",
          );
        }
        if (
          ["imported", "skipped", "importing"].includes(candidate.importState)
        ) {
          continue;
        }
        if (
          candidate.importState === "queued" &&
          candidate.importProjectId !== requested.projectId
        ) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "Repository import is already queued with another project identity.",
          );
        }
        await transaction
          .update(schema.workspaceRepositoryCandidates)
          .set({
            importState: "queued",
            importProjectId: requested.projectId,
            protectedImportName: requested.nameProtection,
            importRepositoryBlindIndex: requested.repositoryBlindIndex,
            importCommandId: null,
            importErrorCode: null,
            importErrorRetryable: null,
            importAvailableAt: now,
            importLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(schema.workspaceRepositoryCandidates.id, candidate.id));
      }
      await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({ stateRevision: job.stateRevision + 1, updatedAt: now })
        .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, job.id));
      return true;
    });
    return queued ? this.getSnapshot(ownerId, workspaceId) : null;
  }

  async claimNextImport(): Promise<ClaimedWorkspaceRepositoryImport | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          candidate: schema.workspaceRepositoryCandidates,
          job: schema.workspaceRepositoryDiscoveryJobs,
          rootPathHandle:
            schema.projectWorkspaceStorageProfiles.protectedRootPathHandle,
        })
        .from(schema.workspaceRepositoryCandidates)
        .innerJoin(
          schema.workspaceRepositoryDiscoveryJobs,
          and(
            eq(
              schema.workspaceRepositoryDiscoveryJobs.id,
              schema.workspaceRepositoryCandidates.jobId,
            ),
            eq(schema.workspaceRepositoryDiscoveryJobs.state, "succeeded"),
          ),
        )
        .innerJoin(
          schema.projectWorkspaceStorageProfiles,
          and(
            eq(
              schema.projectWorkspaceStorageProfiles.workspaceId,
              schema.workspaceRepositoryCandidates.workspaceId,
            ),
            eq(
              schema.projectWorkspaceStorageProfiles.workerId,
              schema.workspaceRepositoryCandidates.workerId,
            ),
            eq(schema.projectWorkspaceStorageProfiles.kind, "attached"),
          ),
        )
        .where(
          and(
            eq(schema.workspaceRepositoryCandidates.importState, "queued"),
            lte(schema.workspaceRepositoryCandidates.importAvailableAt, now),
          ),
        )
        .orderBy(
          asc(schema.workspaceRepositoryCandidates.importAvailableAt),
          asc(schema.workspaceRepositoryCandidates.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const selected = rows[0];
      if (
        !selected?.candidate.importProjectId ||
        !selected.candidate.protectedImportName ||
        !selected.rootPathHandle
      ) {
        return null;
      }
      const commandId = randomUUID();
      const updated = await transaction
        .update(schema.workspaceRepositoryCandidates)
        .set({
          importState: "importing",
          importAttempt: selected.candidate.importAttempt + 1,
          importCommandId: commandId,
          importLeaseExpiresAt: new Date(
            now.getTime() + WORKSPACE_REPOSITORY_IMPORT_LEASE_MS,
          ),
          importErrorCode: null,
          importErrorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaceRepositoryCandidates.id, selected.candidate.id),
            eq(schema.workspaceRepositoryCandidates.importState, "queued"),
          ),
        )
        .returning();
      if (!updated[0]) return null;
      await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({
          stateRevision: selected.job.stateRevision + 1,
          updatedAt: now,
        })
        .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, selected.job.id));
      return {
        attempt: updated[0].importAttempt,
        candidateId: updated[0].id,
        commandId,
        expectedRepositoryFingerprint: updated[0].repositoryFingerprint,
        nameProtection: updated[0].protectedImportName!,
        ownerId: updated[0].ownerId,
        pathHandle: updated[0].protectedPathHandle,
        projectId: updated[0].importProjectId!,
        repositoryBlindIndex: updated[0].importRepositoryBlindIndex,
        rootPathHandle: selected.rootPathHandle,
        workerId: updated[0].workerId,
        workspaceId: updated[0].workspaceId,
      };
    });
  }

  async renewImportLease(claimed: ClaimedWorkspaceRepositoryImport) {
    const rows = await this.database
      .update(schema.workspaceRepositoryCandidates)
      .set({
        importLeaseExpiresAt: new Date(
          Date.now() + WORKSPACE_REPOSITORY_IMPORT_LEASE_MS,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workspaceRepositoryCandidates.id, claimed.candidateId),
          eq(schema.workspaceRepositoryCandidates.importState, "importing"),
          eq(
            schema.workspaceRepositoryCandidates.importCommandId,
            claimed.commandId,
          ),
          eq(
            schema.workspaceRepositoryCandidates.importAttempt,
            claimed.attempt,
          ),
        ),
      )
      .returning({ id: schema.workspaceRepositoryCandidates.id });
    return rows.length === 1;
  }

  async blockImport(
    claimed: ClaimedWorkspaceRepositoryImport,
    error: WorkspaceRepositoryImportError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    return this.settleImport(claimed, "blocked", error);
  }

  async failImport(
    claimed: ClaimedWorkspaceRepositoryImport,
    error: WorkspaceRepositoryImportError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    return this.settleImport(claimed, "failed", error);
  }

  private async settleImport(
    claimed: ClaimedWorkspaceRepositoryImport,
    state: "blocked" | "failed",
    error: WorkspaceRepositoryImportError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    const now = new Date();
    const job = await this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .update(schema.workspaceRepositoryCandidates)
        .set({
          importState: state,
          importCommandId: null,
          importErrorCode: error.code,
          importErrorRetryable: error.retryable,
          importAvailableAt: null,
          importLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaceRepositoryCandidates.id, claimed.candidateId),
            eq(schema.workspaceRepositoryCandidates.importState, "importing"),
            eq(
              schema.workspaceRepositoryCandidates.importCommandId,
              claimed.commandId,
            ),
            eq(
              schema.workspaceRepositoryCandidates.importAttempt,
              claimed.attempt,
            ),
          ),
        )
        .returning({ jobId: schema.workspaceRepositoryCandidates.jobId });
      if (!candidates[0]) {
        throw new WorkspaceRepositoryImportStaleAttemptError(
          "The repository import attempt is no longer current.",
        );
      }
      const jobs = await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({
          stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
          updatedAt: now,
        })
        .where(
          eq(schema.workspaceRepositoryDiscoveryJobs.id, candidates[0].jobId),
        )
        .returning();
      return jobs[0]!;
    });
    return toJob(job);
  }

  async completeImport(
    claimed: ClaimedWorkspaceRepositoryImport,
    result: WorkspaceRepositoryImportValidationResult,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    const now = new Date();
    const job = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          candidate: schema.workspaceRepositoryCandidates,
          job: schema.workspaceRepositoryDiscoveryJobs,
          storage: schema.projectWorkspaceStorageProfiles,
        })
        .from(schema.workspaceRepositoryCandidates)
        .innerJoin(
          schema.workspaceRepositoryDiscoveryJobs,
          eq(
            schema.workspaceRepositoryDiscoveryJobs.id,
            schema.workspaceRepositoryCandidates.jobId,
          ),
        )
        .innerJoin(
          schema.projectWorkspaceStorageProfiles,
          eq(
            schema.projectWorkspaceStorageProfiles.workspaceId,
            schema.workspaceRepositoryCandidates.workspaceId,
          ),
        )
        .where(eq(schema.workspaceRepositoryCandidates.id, claimed.candidateId))
        .for("update")
        .limit(1);
      const current = rows[0];
      if (
        !current ||
        current.candidate.importState !== "importing" ||
        current.candidate.importCommandId !== claimed.commandId ||
        current.candidate.importAttempt !== result.attempt ||
        result.candidateId !== current.candidate.id ||
        result.repositoryFingerprint !==
          current.candidate.repositoryFingerprint ||
        current.storage.kind !== "attached" ||
        current.storage.workerId !== current.candidate.workerId
      ) {
        throw new WorkspaceRepositoryImportStaleAttemptError(
          "The repository import completion is no longer current.",
        );
      }

      const checkoutConflicts = await transaction
        .select({
          projectId: schema.projects.id,
          workspaceId: schema.projectWorkspaceMemberships.workspaceId,
        })
        .from(schema.projectSources)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.projectSources.projectId),
            eq(schema.projects.ownerId, claimed.ownerId),
          ),
        )
        .innerJoin(
          schema.projectWorkspaceMemberships,
          eq(schema.projectWorkspaceMemberships.projectId, schema.projects.id),
        )
        .where(
          and(
            eq(schema.projectSources.workerId, claimed.workerId),
            eq(
              schema.projectSources.repositoryFingerprint,
              result.repositoryFingerprint,
            ),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .orderBy(asc(schema.projectSources.createdAt))
        .limit(1);
      const githubConflicts = result.github
        ? await transaction
            .select({
              projectId: schema.projects.id,
              workspaceId: schema.projectWorkspaceMemberships.workspaceId,
            })
            .from(schema.projects)
            .innerJoin(
              schema.projectWorkspaceMemberships,
              eq(
                schema.projectWorkspaceMemberships.projectId,
                schema.projects.id,
              ),
            )
            .where(
              and(
                eq(schema.projects.ownerId, claimed.ownerId),
                or(
                  eq(
                    schema.projects.githubRepositoryId,
                    result.github.repositoryId,
                  ),
                  claimed.repositoryBlindIndex
                    ? eq(
                        schema.projects.githubRepositoryBlindIndex,
                        claimed.repositoryBlindIndex,
                      )
                    : undefined,
                ),
              ),
            )
            .orderBy(asc(schema.projects.createdAt))
            .limit(1)
        : [];
      const conflict = checkoutConflicts[0] ?? githubConflicts[0];
      if (conflict) {
        await transaction
          .update(schema.workspaceRepositoryCandidates)
          .set({
            importState: "skipped",
            importProjectId: conflict.projectId,
            importCommandId: null,
            importErrorCode: null,
            importErrorRetryable: null,
            importAvailableAt: null,
            importLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            eq(schema.workspaceRepositoryCandidates.id, claimed.candidateId),
          );
      } else {
        const projectCollision = await transaction
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, claimed.projectId))
          .limit(1);
        if (projectCollision[0]) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "Repository import project identity already exists.",
          );
        }
        const githubImport = Boolean(
          result.classification === "github-accessible" &&
          result.github &&
          claimed.repositoryBlindIndex,
        );
        const lastProjects = await transaction
          .select({ position: schema.projects.position })
          .from(schema.projects)
          .where(eq(schema.projects.ownerId, claimed.ownerId))
          .orderBy(desc(schema.projects.position))
          .limit(1);
        await transaction.insert(schema.projects).values({
          id: claimed.projectId,
          ownerId: claimed.ownerId,
          protectedLabel: claimed.nameProtection,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: githubImport ? "github" : "managed-folder",
          folderManagement: githubImport ? null : "external",
          setupStatus: "ready",
          setupError: null,
          worktreePolicy: githubImport ? "agent-managed" : "direct",
          gitCapability: true,
          githubCapability: githubImport,
          preferredWorkerId: claimed.workerId,
          githubRepositoryBlindIndex: githubImport
            ? claimed.repositoryBlindIndex
            : null,
          githubRepositoryId: githubImport ? result.github!.repositoryId : null,
          githubRepositoryFullName: githubImport
            ? result.github!.nameWithOwner
            : null,
          githubRepositoryUrl: githubImport ? result.github!.url : null,
          createdAt: now,
          updatedAt: now,
        });
        await transaction.insert(schema.projectWorkspaceMemberships).values({
          workspaceId: claimed.workspaceId,
          projectId: claimed.projectId,
          createdAt: now,
        });
        const sourceId = randomUUID();
        await transaction.insert(schema.projectSources).values({
          id: sourceId,
          projectId: claimed.projectId,
          workerId: claimed.workerId,
          sourceKind: "git",
          absolutePath: result.path,
          displayPath: result.displayPath,
          placementMode: "direct",
          ownershipKind: "user",
          requestedPath: result.path,
          linkPath: null,
          repositoryFingerprint: result.repositoryFingerprint,
          createdAt: now,
          updatedAt: now,
        });
        await transaction.insert(schema.projectWorktrees).values({
          id: randomUUID(),
          projectSourceId: sourceId,
          workerId: claimed.workerId,
          rootKind: "git-worktree",
          name: "Primary",
          absolutePath: result.path,
          displayPath: result.displayPath,
          isPrimary: true,
          isDefault: true,
          origin: "external",
          lifecycleState: "ready",
          branch: result.branch,
          head: result.head,
          detached: result.head !== null && result.branch === null,
          lastScannedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await transaction
          .update(schema.workspaceRepositoryCandidates)
          .set({
            classification: result.classification,
            diagnosticCode: result.diagnosticCode,
            protectedPathHandle: result.path,
            protectedOriginUrlHandle: result.originUrl,
            protectedGithubRepositoryIdHandle:
              result.github?.repositoryId ?? null,
            protectedGithubNameWithOwnerHandle:
              result.github?.nameWithOwner ?? null,
            protectedGithubUrlHandle: result.github?.url ?? null,
            importState: "imported",
            importCommandId: null,
            importErrorCode: null,
            importErrorRetryable: null,
            importAvailableAt: null,
            importLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            eq(schema.workspaceRepositoryCandidates.id, claimed.candidateId),
          );
      }
      const jobs = await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({
          stateRevision: current.job.stateRevision + 1,
          updatedAt: now,
        })
        .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, current.job.id))
        .returning();
      return jobs[0]!;
    });
    return toJob(job);
  }

  async recoverInterruptedImports(
    force = true,
    now = new Date(),
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const recovered = await transaction
        .update(schema.workspaceRepositoryCandidates)
        .set({
          importState: "queued",
          importCommandId: null,
          importLeaseExpiresAt: null,
          importAvailableAt: now,
          updatedAt: now,
        })
        .where(
          force
            ? eq(schema.workspaceRepositoryCandidates.importState, "importing")
            : and(
                eq(
                  schema.workspaceRepositoryCandidates.importState,
                  "importing",
                ),
                or(
                  isNull(
                    schema.workspaceRepositoryCandidates.importLeaseExpiresAt,
                  ),
                  lte(
                    schema.workspaceRepositoryCandidates.importLeaseExpiresAt,
                    now,
                  ),
                ),
              ),
        )
        .returning({
          jobId: schema.workspaceRepositoryCandidates.jobId,
        });
      for (const jobId of new Set(recovered.map((row) => row.jobId))) {
        await transaction
          .update(schema.workspaceRepositoryDiscoveryJobs)
          .set({
            stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, jobId));
      }
      return recovered.length;
    });
  }

  async requeueRetryableImportsForWorker(workerId: string): Promise<number> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const requeued = await transaction
        .update(schema.workspaceRepositoryCandidates)
        .set({
          importState: "queued",
          importErrorCode: null,
          importErrorRetryable: null,
          importAvailableAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaceRepositoryCandidates.workerId, workerId),
            eq(schema.workspaceRepositoryCandidates.importState, "blocked"),
            eq(schema.workspaceRepositoryCandidates.importErrorRetryable, true),
          ),
        )
        .returning({
          jobId: schema.workspaceRepositoryCandidates.jobId,
        });
      for (const jobId of new Set(requeued.map((row) => row.jobId))) {
        await transaction
          .update(schema.workspaceRepositoryDiscoveryJobs)
          .set({
            stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, jobId));
      }
      return requeued.length;
    });
  }

  async queue(
    ownerId: string,
    workspaceId: string,
    input: { depth?: number; expectedStateRevision?: number } = {},
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary | null> {
    const now = new Date();
    const depth = input.depth ?? 3;
    if (!Number.isInteger(depth) || depth < 0 || depth > 16) {
      throw new WorkspaceRepositoryDiscoveryInvariantError(
        "Workspace repository discovery depth is invalid.",
      );
    }
    const row = await this.database.transaction(async (transaction) => {
      const workspaces = await transaction
        .select({
          workspace: schema.projectWorkspaces,
          storage: schema.projectWorkspaceStorageProfiles,
        })
        .from(schema.projectWorkspaces)
        .innerJoin(
          schema.projectWorkspaceStorageProfiles,
          eq(
            schema.projectWorkspaceStorageProfiles.workspaceId,
            schema.projectWorkspaces.id,
          ),
        )
        .where(
          and(
            eq(schema.projectWorkspaces.id, workspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const workspace = workspaces[0];
      if (
        workspace?.storage.kind !== "attached" ||
        !workspace.storage.workerId ||
        !workspace.storage.protectedRootPathHandle
      ) {
        throw new WorkspaceRepositoryDiscoveryInvariantError(
          "Repository discovery is available only for attached workspaces.",
        );
      }
      const existing = await transaction
        .select()
        .from(schema.workspaceRepositoryDiscoveryJobs)
        .where(
          eq(schema.workspaceRepositoryDiscoveryJobs.workspaceId, workspaceId),
        )
        .for("update")
        .limit(1);
      const job = existing[0];
      if (job) {
        if (
          job.state === "running" ||
          (input.expectedStateRevision !== undefined &&
            job.stateRevision !== input.expectedStateRevision)
        ) {
          return null;
        }
        const updated = await transaction
          .update(schema.workspaceRepositoryDiscoveryJobs)
          .set({
            state: "queued",
            stateRevision: job.stateRevision + 1,
            depth,
            commandId: null,
            lastErrorCode: null,
            errorRetryable: null,
            truncated: false,
            candidateCount: null,
            collapsedRepositoryCount: null,
            rejectedRepositoryCount: null,
            scannedDirectoryCount: null,
            scannedEntryCount: null,
            skippedSymlinkCount: null,
            unreadableDirectoryCount: null,
            availableAt: now,
            leaseExpiresAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workspaceRepositoryDiscoveryJobs.id, job.id),
              eq(
                schema.workspaceRepositoryDiscoveryJobs.stateRevision,
                job.stateRevision,
              ),
            ),
          )
          .returning();
        return updated[0] ?? null;
      }
      if (input.expectedStateRevision !== undefined) return null;
      const inserted = await transaction
        .insert(schema.workspaceRepositoryDiscoveryJobs)
        .values({
          id: randomUUID(),
          ownerId,
          workspaceId,
          workerId: workspace.storage.workerId,
          state: "queued",
          depth,
          availableAt: now,
          updatedAt: now,
        })
        .returning();
      return inserted[0] ?? null;
    });
    return row ? toJob(row) : null;
  }

  async claimNext(): Promise<ClaimedWorkspaceRepositoryDiscoveryJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          job: schema.workspaceRepositoryDiscoveryJobs,
          rootPathHandle:
            schema.projectWorkspaceStorageProfiles.protectedRootPathHandle,
        })
        .from(schema.workspaceRepositoryDiscoveryJobs)
        .innerJoin(
          schema.projectWorkspaceStorageProfiles,
          and(
            eq(
              schema.projectWorkspaceStorageProfiles.workspaceId,
              schema.workspaceRepositoryDiscoveryJobs.workspaceId,
            ),
            eq(
              schema.projectWorkspaceStorageProfiles.workerId,
              schema.workspaceRepositoryDiscoveryJobs.workerId,
            ),
            eq(schema.projectWorkspaceStorageProfiles.kind, "attached"),
          ),
        )
        .where(
          and(
            eq(schema.workspaceRepositoryDiscoveryJobs.state, "queued"),
            lte(schema.workspaceRepositoryDiscoveryJobs.availableAt, now),
          ),
        )
        .orderBy(
          asc(schema.workspaceRepositoryDiscoveryJobs.availableAt),
          asc(schema.workspaceRepositoryDiscoveryJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate?.rootPathHandle) return null;
      const commandId = randomUUID();
      const updated = await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({
          state: "running",
          stateRevision: candidate.job.stateRevision + 1,
          attempt: candidate.job.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(
            now.getTime() + WORKSPACE_REPOSITORY_DISCOVERY_JOB_LEASE_MS,
          ),
          startedAt: now,
          completedAt: null,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaceRepositoryDiscoveryJobs.id, candidate.job.id),
            eq(schema.workspaceRepositoryDiscoveryJobs.state, "queued"),
            eq(
              schema.workspaceRepositoryDiscoveryJobs.stateRevision,
              candidate.job.stateRevision,
            ),
          ),
        )
        .returning();
      if (!updated[0]) return null;
      return {
        commandId,
        job: toJob(updated[0]),
        ownerId: updated[0].ownerId,
        rootPathHandle: candidate.rootPathHandle,
      };
    });
  }

  async renewLease(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.workspaceRepositoryDiscoveryJobs)
      .set({
        leaseExpiresAt: new Date(
          now.getTime() + WORKSPACE_REPOSITORY_DISCOVERY_JOB_LEASE_MS,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspaceRepositoryDiscoveryJobs.id, jobId),
          eq(schema.workspaceRepositoryDiscoveryJobs.state, "running"),
          eq(schema.workspaceRepositoryDiscoveryJobs.commandId, commandId),
          eq(schema.workspaceRepositoryDiscoveryJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.workspaceRepositoryDiscoveryJobs.id });
    return rows.length === 1;
  }

  async block(
    jobId: string,
    commandId: string,
    error: WorkspaceRepositoryDiscoveryError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    return this.settle(jobId, commandId, "blocked", error);
  }

  async fail(
    jobId: string,
    commandId: string,
    error: WorkspaceRepositoryDiscoveryError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    return this.settle(jobId, commandId, "failed", error);
  }

  private async settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: WorkspaceRepositoryDiscoveryError,
  ): Promise<WorkspaceRepositoryDiscoveryJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.workspaceRepositoryDiscoveryJobs)
      .set({
        state,
        stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        completedAt: state === "failed" ? now : null,
        lastErrorCode: error.code,
        errorRetryable: error.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspaceRepositoryDiscoveryJobs.id, jobId),
          eq(schema.workspaceRepositoryDiscoveryJobs.state, "running"),
          eq(schema.workspaceRepositoryDiscoveryJobs.commandId, commandId),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new WorkspaceRepositoryDiscoveryStaleAttemptError(
        "The repository discovery attempt is no longer current.",
      );
    }
    return toJob(rows[0]);
  }

  async complete(
    jobId: string,
    commandId: string,
    input: {
      attempt: number;
      candidates: DiscoveredWorkspaceRepositoryCandidate[];
      counts: WorkspaceRepositoryDiscoveryCounts;
      truncated: boolean;
    },
  ): Promise<WorkspaceRepositoryDiscoverySnapshot> {
    const now = new Date();
    const parsedCounts = workspaceRepositoryDiscoveryCountsSchema.parse(
      input.counts,
    );
    if (parsedCounts.candidates !== input.candidates.length) {
      throw new WorkspaceRepositoryDiscoveryInvariantError(
        "Repository discovery candidate counts do not match.",
      );
    }
    if (input.candidates.length > 500) {
      throw new WorkspaceRepositoryDiscoveryInvariantError(
        "Repository discovery returned too many candidates.",
      );
    }
    const candidates = input.candidates.map((candidate) => ({
      classification: workspaceRepositoryCandidateClassificationSchema.parse(
        candidate.classification ?? "unclassified",
      ),
      diagnosticCode: workspaceRepositoryCandidateDiagnosticCodeSchema
        .nullable()
        .parse(candidate.diagnosticCode?.trim() || null),
      displayHandle: repositoryRoutingHandleSchema.parse(
        candidate.displayHandle,
      ),
      originUrlHandle: candidate.originUrlHandle
        ? repositoryRoutingHandleSchema.parse(candidate.originUrlHandle)
        : null,
      github: candidate.github
        ? {
            repositoryId: repositoryRoutingHandleSchema.parse(
              candidate.github.repositoryId,
            ),
            nameWithOwner: repositoryRoutingHandleSchema.parse(
              candidate.github.nameWithOwner,
            ),
            url: repositoryRoutingHandleSchema.parse(candidate.github.url),
          }
        : null,
      pathHandle: repositoryRoutingHandleSchema.parse(candidate.pathHandle),
      repositoryFingerprint: (() => {
        if (!/^[0-9a-f]{64}$/u.test(candidate.repositoryFingerprint)) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "Repository discovery fingerprint is invalid.",
          );
        }
        return candidate.repositoryFingerprint;
      })(),
    }));
    for (const candidate of candidates) {
      const hasOrigin = candidate.originUrlHandle !== null;
      const hasGithub = candidate.github !== null;
      const hasDiagnostic = candidate.diagnosticCode !== null;
      const unsupportedDiagnostic =
        candidate.diagnosticCode === "bare-repository" ||
        candidate.diagnosticCode === "linked-worktree";
      const valid =
        (candidate.classification === "github-accessible" &&
          hasOrigin &&
          hasGithub &&
          !hasDiagnostic) ||
        (candidate.classification === "github-unavailable" &&
          hasOrigin &&
          !hasGithub &&
          hasDiagnostic &&
          !unsupportedDiagnostic) ||
        ((candidate.classification === "unclassified" ||
          candidate.classification === "local-git") &&
          !hasGithub &&
          !unsupportedDiagnostic) ||
        (candidate.classification === "unsupported" &&
          !hasGithub &&
          unsupportedDiagnostic);
      if (!valid) {
        throw new WorkspaceRepositoryDiscoveryInvariantError(
          "Repository discovery classification metadata is invalid.",
        );
      }
    }
    if (
      new Set(
        candidates.map(({ repositoryFingerprint }) => repositoryFingerprint),
      ).size !== candidates.length
    ) {
      throw new WorkspaceRepositoryDiscoveryInvariantError(
        "Repository discovery returned duplicate fingerprints.",
      );
    }
    const result = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(schema.workspaceRepositoryDiscoveryJobs)
        .where(eq(schema.workspaceRepositoryDiscoveryJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = jobs[0];
      if (
        !job ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== input.attempt
      ) {
        throw new WorkspaceRepositoryDiscoveryStaleAttemptError(
          "The repository discovery completion is no longer current.",
        );
      }
      for (const candidate of candidates) {
        await transaction
          .insert(schema.workspaceRepositoryCandidates)
          .values({
            id: randomUUID(),
            ownerId: job.ownerId,
            jobId: job.id,
            workspaceId: job.workspaceId,
            workerId: job.workerId,
            protectedPathHandle: candidate.pathHandle,
            protectedDisplayHandle: candidate.displayHandle,
            protectedOriginUrlHandle: candidate.originUrlHandle,
            protectedGithubRepositoryIdHandle:
              candidate.github?.repositoryId ?? null,
            protectedGithubNameWithOwnerHandle:
              candidate.github?.nameWithOwner ?? null,
            protectedGithubUrlHandle: candidate.github?.url ?? null,
            repositoryFingerprint: candidate.repositoryFingerprint,
            classification: candidate.classification,
            diagnosticCode: candidate.diagnosticCode,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.workspaceRepositoryCandidates.workspaceId,
              schema.workspaceRepositoryCandidates.repositoryFingerprint,
            ],
            set: {
              jobId: job.id,
              workerId: job.workerId,
              protectedPathHandle: candidate.pathHandle,
              protectedDisplayHandle: candidate.displayHandle,
              protectedOriginUrlHandle: candidate.originUrlHandle,
              protectedGithubRepositoryIdHandle:
                candidate.github?.repositoryId ?? null,
              protectedGithubNameWithOwnerHandle:
                candidate.github?.nameWithOwner ?? null,
              protectedGithubUrlHandle: candidate.github?.url ?? null,
              classification: candidate.classification,
              diagnosticCode: candidate.diagnosticCode,
              updatedAt: now,
            },
          });
      }
      const removableStates = ["pending", "failed", "skipped"] as const;
      const staleFilter = and(
        eq(schema.workspaceRepositoryCandidates.workspaceId, job.workspaceId),
        inArray(schema.workspaceRepositoryCandidates.importState, [
          ...removableStates,
        ]),
        ...(candidates.length > 0
          ? [
              notInArray(
                schema.workspaceRepositoryCandidates.repositoryFingerprint,
                candidates.map(
                  ({ repositoryFingerprint }) => repositoryFingerprint,
                ),
              ),
            ]
          : []),
      );
      await transaction
        .delete(schema.workspaceRepositoryCandidates)
        .where(staleFilter);
      const completed = await transaction
        .update(schema.workspaceRepositoryDiscoveryJobs)
        .set({
          state: "succeeded",
          stateRevision: job.stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: null,
          errorRetryable: null,
          truncated: input.truncated,
          candidateCount: parsedCounts.candidates,
          collapsedRepositoryCount: parsedCounts.collapsedRepositories,
          rejectedRepositoryCount: parsedCounts.rejectedRepositories,
          scannedDirectoryCount: parsedCounts.scannedDirectories,
          scannedEntryCount: parsedCounts.scannedEntries,
          skippedSymlinkCount: parsedCounts.skippedSymlinks,
          unreadableDirectoryCount: parsedCounts.unreadableDirectories,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaceRepositoryDiscoveryJobs.id, job.id),
            eq(schema.workspaceRepositoryDiscoveryJobs.commandId, commandId),
          ),
        )
        .returning();
      const candidateRows = await transaction
        .select()
        .from(schema.workspaceRepositoryCandidates)
        .where(
          eq(schema.workspaceRepositoryCandidates.workspaceId, job.workspaceId),
        )
        .orderBy(asc(schema.workspaceRepositoryCandidates.createdAt));
      return { job: completed[0]!, candidates: candidateRows };
    });
    return workspaceRepositoryDiscoverySnapshotSchema.parse({
      job: toJob(result.job),
      candidates: result.candidates.map((candidate) => toCandidate(candidate)),
    });
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    const rows = await this.database
      .update(schema.workspaceRepositoryDiscoveryJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        lastErrorCode: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        force
          ? eq(schema.workspaceRepositoryDiscoveryJobs.state, "running")
          : and(
              eq(schema.workspaceRepositoryDiscoveryJobs.state, "running"),
              or(
                isNull(schema.workspaceRepositoryDiscoveryJobs.leaseExpiresAt),
                lte(
                  schema.workspaceRepositoryDiscoveryJobs.leaseExpiresAt,
                  now,
                ),
              ),
            ),
      )
      .returning({ id: schema.workspaceRepositoryDiscoveryJobs.id });
    return rows.length;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.workspaceRepositoryDiscoveryJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.workspaceRepositoryDiscoveryJobs.stateRevision} + 1`,
        availableAt: now,
        lastErrorCode: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspaceRepositoryDiscoveryJobs.workerId, workerId),
          eq(schema.workspaceRepositoryDiscoveryJobs.state, "blocked"),
          eq(schema.workspaceRepositoryDiscoveryJobs.errorRetryable, true),
        ),
      )
      .returning({ id: schema.workspaceRepositoryDiscoveryJobs.id });
    return rows.length;
  }
}
