import { randomUUID } from "node:crypto";

import {
  workspaceRepositoryCandidateClassificationSchema,
  workspaceRepositoryCandidateSummarySchema,
  workspaceRepositoryDiscoveryCountsSchema,
  workspaceRepositoryDiscoveryJobSummarySchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  type WorkspaceRepositoryCandidateClassification,
  type WorkspaceRepositoryDiscoveryCounts,
  type WorkspaceRepositoryDiscoveryError,
  type WorkspaceRepositoryDiscoveryJobSummary,
  type WorkspaceRepositoryDiscoverySnapshot,
} from "@cantrip/protocol";
import { repositoryRoutingHandleSchema } from "@cantrip/protocol/repository-operation";
import {
  and,
  asc,
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

export class WorkspaceRepositoryDiscoveryInvariantError extends Error {}
export class WorkspaceRepositoryDiscoveryStaleAttemptError extends Error {}

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
  pathHandle: string;
  repositoryFingerprint: string;
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

function toCandidate(row: CandidateRow) {
  return workspaceRepositoryCandidateSummarySchema.parse({
    id: row.id,
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    workerId: row.workerId,
    pathHandle: row.protectedPathHandle,
    displayHandle: row.protectedDisplayHandle,
    repositoryFingerprint: row.repositoryFingerprint,
    classification: row.classification,
    importState: row.importState,
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
    return workspaceRepositoryDiscoverySnapshotSchema.parse({
      job: toJob(job),
      candidates: candidates.map(toCandidate),
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
      diagnosticCode: (() => {
        const value = candidate.diagnosticCode?.trim() || null;
        if (value && value.length > 200) {
          throw new WorkspaceRepositoryDiscoveryInvariantError(
            "Repository discovery diagnostic code is invalid.",
          );
        }
        return value;
      })(),
      displayHandle: repositoryRoutingHandleSchema.parse(
        candidate.displayHandle,
      ),
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
      candidates: result.candidates.map(toCandidate),
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
