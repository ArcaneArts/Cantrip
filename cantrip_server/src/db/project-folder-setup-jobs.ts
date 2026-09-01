import { randomUUID } from "node:crypto";

import {
  projectFolderSetupJobSummarySchema,
  type ManagedFolderMaterializeReady,
  type ProjectFolderSetupJobError,
  type ProjectFolderSetupJobSummary,
} from "@cantrip/protocol";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type JobRow = typeof schema.projectFolderSetupJobs.$inferSelect;

export const PROJECT_FOLDER_SETUP_JOB_LEASE_MS = 2 * 60_000;

export class ProjectFolderSetupJobNotFoundError extends Error {}
export class ProjectFolderSetupJobConflictError extends Error {}
export class ProjectFolderSetupJobStaleAttemptError extends Error {}

export interface ClaimedProjectFolderSetupJob {
  commandId: string;
  existingPath: string | null;
  job: ProjectFolderSetupJobSummary;
  ownerId: string;
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function toJob(row: JobRow): ProjectFolderSetupJobSummary {
  return projectFolderSetupJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    workerId: row.workerId,
    state: row.state,
    stateRevision: row.stateRevision,
    attempt: row.attempt,
    error: row.lastErrorCode
      ? {
          code: row.lastErrorCode,
          retryable: row.errorRetryable ?? false,
        }
      : null,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
    startedAt: row.startedAt ? toISOString(row.startedAt) : null,
    completedAt: row.completedAt ? toISOString(row.completedAt) : null,
  });
}

export class ProjectFolderSetupJobRepository {
  constructor(private readonly database: Database) {}

  async get(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectFolderSetupJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectFolderSetupJobs)
      .where(
        and(
          eq(schema.projectFolderSetupJobs.ownerId, ownerId),
          eq(schema.projectFolderSetupJobs.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async claimNext(): Promise<ClaimedProjectFolderSetupJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ job: schema.projectFolderSetupJobs })
        .from(schema.projectFolderSetupJobs)
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.projectFolderSetupJobs.projectId),
        )
        .where(
          and(
            eq(schema.projectFolderSetupJobs.state, "queued"),
            lte(schema.projectFolderSetupJobs.availableAt, now),
          ),
        )
        .orderBy(
          asc(schema.projectFolderSetupJobs.availableAt),
          asc(schema.projectFolderSetupJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.projectFolderSetupJobs)
        .set({
          state: "running",
          stateRevision: candidate.job.stateRevision + 1,
          attempt: candidate.job.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(
            now.getTime() + PROJECT_FOLDER_SETUP_JOB_LEASE_MS,
          ),
          startedAt: candidate.job.startedAt ?? now,
          completedAt: null,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectFolderSetupJobs.id, candidate.job.id),
            eq(schema.projectFolderSetupJobs.state, "queued"),
            eq(
              schema.projectFolderSetupJobs.stateRevision,
              candidate.job.stateRevision,
            ),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      return {
        ownerId: rows[0].ownerId,
        commandId,
        existingPath: rows[0].requestedPath,
        job: toJob(rows[0]),
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
      .update(schema.projectFolderSetupJobs)
      .set({
        leaseExpiresAt: new Date(
          now.getTime() + PROJECT_FOLDER_SETUP_JOB_LEASE_MS,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectFolderSetupJobs.id, jobId),
          eq(schema.projectFolderSetupJobs.state, "running"),
          eq(schema.projectFolderSetupJobs.commandId, commandId),
          eq(schema.projectFolderSetupJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.projectFolderSetupJobs.id });
    return rows.length === 1;
  }

  async block(
    jobId: string,
    commandId: string,
    error: ProjectFolderSetupJobError,
  ): Promise<ProjectFolderSetupJobSummary> {
    return this.settle(jobId, commandId, "blocked", error);
  }

  async fail(
    jobId: string,
    commandId: string,
    error: ProjectFolderSetupJobError,
  ): Promise<ProjectFolderSetupJobSummary> {
    return this.settle(jobId, commandId, "failed", error);
  }

  private async settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: ProjectFolderSetupJobError,
  ): Promise<ProjectFolderSetupJobSummary> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.projectFolderSetupJobs)
        .set({
          state,
          stateRevision: sql`${schema.projectFolderSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          completedAt: state === "failed" ? now : null,
          lastErrorCode: error.code,
          errorRetryable: error.retryable,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectFolderSetupJobs.id, jobId),
            eq(schema.projectFolderSetupJobs.state, "running"),
            eq(schema.projectFolderSetupJobs.commandId, commandId),
          ),
        )
        .returning();
      const updated = rows[0];
      if (!updated) {
        throw new ProjectFolderSetupJobStaleAttemptError(
          "The folder setup attempt is no longer current.",
        );
      }
      await transaction
        .update(schema.projects)
        .set({
          setupStatus: state === "failed" ? "failed" : "preparing",
          setupError: error.code,
          updatedAt: now,
        })
        .where(eq(schema.projects.id, updated.projectId));
      return updated;
    });
    return toJob(row);
  }

  async complete(
    jobId: string,
    commandId: string,
    result: ManagedFolderMaterializeReady,
  ): Promise<ProjectFolderSetupJobSummary> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.projectFolderSetupJobs)
        .where(eq(schema.projectFolderSetupJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = rows[0];
      if (
        !job ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== result.attempt ||
        job.id !== result.jobId
      ) {
        throw new ProjectFolderSetupJobStaleAttemptError(
          "The folder setup completion is no longer current.",
        );
      }
      const projects = await transaction
        .select({ originKind: schema.projects.originKind })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, job.projectId),
            eq(schema.projects.ownerId, job.ownerId),
          ),
        )
        .limit(1);
      if (projects[0]?.originKind !== "managed-folder") {
        throw new ProjectFolderSetupJobConflictError(
          "The folder project no longer exists or changed origin.",
        );
      }
      const sourceId = randomUUID();
      await transaction.insert(schema.projectSources).values({
        id: sourceId,
        projectId: job.projectId,
        workerId: job.workerId,
        sourceKind: result.repositoryFingerprint ? "git" : "folder",
        absolutePath: result.path,
        displayPath: result.displayPath,
        repositoryFingerprint: result.repositoryFingerprint,
      });
      await transaction.insert(schema.projectWorktrees).values({
        id: randomUUID(),
        projectSourceId: sourceId,
        workerId: job.workerId,
        rootKind: result.repositoryFingerprint ? "git-worktree" : "folder-root",
        name: "Primary",
        absolutePath: result.path,
        displayPath: result.displayPath,
        isPrimary: true,
        isDefault: true,
        origin: job.requestedPath ? "external" : "cantrip",
        lifecycleState: "ready",
      });
      await transaction
        .update(schema.projects)
        .set({
          setupStatus: "ready",
          setupError: null,
          gitCapability: result.repositoryFingerprint !== null,
          githubCapability: result.github !== null,
          githubRepositoryBlindIndex: result.github?.repositoryId ?? null,
          githubRepositoryId: result.github?.repositoryId ?? null,
          githubRepositoryFullName: result.github?.nameWithOwner ?? null,
          githubRepositoryUrl: result.github?.url ?? null,
          updatedAt: now,
        })
        .where(eq(schema.projects.id, job.projectId));
      const completed = await transaction
        .update(schema.projectFolderSetupJobs)
        .set({
          state: "succeeded",
          stateRevision: sql`${schema.projectFolderSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          errorRetryable: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectFolderSetupJobs.id, jobId),
            eq(schema.projectFolderSetupJobs.commandId, commandId),
          ),
        )
        .returning();
      return completed[0]!;
    });
    return toJob(row);
  }

  async retry(
    ownerId: string,
    projectId: string,
    stateRevision: number,
  ): Promise<ProjectFolderSetupJobSummary | null> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.projectFolderSetupJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.projectFolderSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          availableAt: now,
          completedAt: null,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectFolderSetupJobs.ownerId, ownerId),
            eq(schema.projectFolderSetupJobs.projectId, projectId),
            eq(schema.projectFolderSetupJobs.stateRevision, stateRevision),
            or(
              eq(schema.projectFolderSetupJobs.state, "blocked"),
              eq(schema.projectFolderSetupJobs.state, "failed"),
            ),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      await transaction
        .update(schema.projects)
        .set({ setupStatus: "preparing", setupError: null, updatedAt: now })
        .where(eq(schema.projects.id, projectId));
      return rows[0];
    });
    return row ? toJob(row) : null;
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    const rows = await this.database
      .update(schema.projectFolderSetupJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.projectFolderSetupJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        lastErrorCode: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        force
          ? eq(schema.projectFolderSetupJobs.state, "running")
          : and(
              eq(schema.projectFolderSetupJobs.state, "running"),
              or(
                isNull(schema.projectFolderSetupJobs.leaseExpiresAt),
                lte(schema.projectFolderSetupJobs.leaseExpiresAt, now),
              ),
            ),
      )
      .returning({ id: schema.projectFolderSetupJobs.id });
    return rows.length;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectFolderSetupJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.projectFolderSetupJobs.stateRevision} + 1`,
          availableAt: now,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectFolderSetupJobs.workerId, workerId),
            eq(schema.projectFolderSetupJobs.state, "blocked"),
            eq(schema.projectFolderSetupJobs.errorRetryable, true),
          ),
        )
        .returning({ projectId: schema.projectFolderSetupJobs.projectId });
      for (const projectId of new Set(
        updated.map(({ projectId }) => projectId),
      )) {
        await transaction
          .update(schema.projects)
          .set({ setupStatus: "preparing", setupError: null, updatedAt: now })
          .where(eq(schema.projects.id, projectId));
      }
      return updated;
    });
    return rows.length;
  }
}
