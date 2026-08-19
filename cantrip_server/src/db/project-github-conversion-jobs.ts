import { randomUUID } from "node:crypto";

import {
  projectGithubConversionJobSummarySchema,
  type ProjectGithubConversionError,
  type ProjectGithubConversionJobSummary,
  type ProjectGithubConversionReady,
  type ProjectGithubConversionStart,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type JobRow = typeof schema.projectGithubConversionJobs.$inferSelect;

const ACTIVE_WORKFLOW_STATES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "cancelling",
  "recovering",
] as const;

export const PROJECT_GITHUB_CONVERSION_JOB_LEASE_MS = 2 * 60_000;

export class ProjectGithubConversionJobNotFoundError extends Error {}
export class ProjectGithubConversionJobConflictError extends Error {}
export class ProjectGithubConversionJobStaleAttemptError extends Error {}

export interface ClaimedProjectGithubConversionJob {
  commandId: string;
  confirmationToken: string;
  initialCommit: { message: string } | null;
  job: ProjectGithubConversionJobSummary;
  ownerId: string;
}

export interface ConvertedManagedFolderSource {
  localFilesDeleted: boolean;
  projectSourceId: string;
  workerId: string;
}

function toJob(row: JobRow): ProjectGithubConversionJobSummary {
  return projectGithubConversionJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    workerId: row.workerId,
    repository: {
      repositoryId: row.repositoryId,
      nameWithOwner: row.repositoryFullName,
      url: row.repositoryUrl,
    },
    state: row.state,
    stateRevision: row.stateRevision,
    attempt: row.attempt,
    initialCommitRequested: row.initialCommitMessage !== null,
    error:
      row.lastErrorCode && row.lastErrorMessage !== null
        ? {
            code: row.lastErrorCode,
            message: row.lastErrorMessage,
            retryable: row.errorRetryable ?? false,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

export class ProjectGithubConversionJobRepository {
  constructor(private readonly database: Database) {}

  async get(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectGithubConversionJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectGithubConversionJobs)
      .where(
        and(
          eq(schema.projectGithubConversionJobs.ownerId, ownerId),
          eq(schema.projectGithubConversionJobs.projectId, projectId),
        ),
      )
      .orderBy(desc(schema.projectGithubConversionJobs.createdAt))
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async hasActiveProjectJob(projectId: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projectGithubConversionJobs.id })
      .from(schema.projectGithubConversionJobs)
      .where(
        and(
          eq(schema.projectGithubConversionJobs.projectId, projectId),
          inArray(schema.projectGithubConversionJobs.state, [
            "queued",
            "running",
            "blocked",
          ]),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  async convertedManagedFolderSource(
    ownerId: string,
    projectId: string,
  ): Promise<ConvertedManagedFolderSource | null> {
    const rows = await this.database
      .select({
        localFilesDeletedAt:
          schema.projectGithubConversionJobs.localFilesDeletedAt,
        projectSourceId: schema.projectGithubConversionJobs.projectSourceId,
        workerId: schema.projectGithubConversionJobs.workerId,
      })
      .from(schema.projectGithubConversionJobs)
      .where(
        and(
          eq(schema.projectGithubConversionJobs.ownerId, ownerId),
          eq(schema.projectGithubConversionJobs.projectId, projectId),
          eq(schema.projectGithubConversionJobs.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.projectGithubConversionJobs.completedAt))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          localFilesDeleted: row.localFilesDeletedAt !== null,
          projectSourceId: row.projectSourceId,
          workerId: row.workerId,
        }
      : null;
  }

  async isConvertedManagedFolderSource(
    ownerId: string,
    projectId: string,
    projectSourceId: string,
  ): Promise<boolean> {
    const source = await this.convertedManagedFolderSource(ownerId, projectId);
    return source?.projectSourceId === projectSourceId;
  }

  async create(
    ownerId: string,
    projectId: string,
    workerId: string,
    input: ProjectGithubConversionStart,
  ): Promise<ProjectGithubConversionJobSummary> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const projects = await transaction
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const project = projects[0];
      if (!project) throw new ProjectGithubConversionJobNotFoundError();
      if (
        project.originKind !== "managed-folder" ||
        project.setupStatus !== "ready" ||
        project.preferredWorkerId !== workerId
      ) {
        throw new ProjectGithubConversionJobConflictError(
          "Only a ready folder project on its owning worker can be converted.",
        );
      }
      const [activeJobs, collisions, activeWorkflows, sources] =
        await Promise.all([
          transaction
            .select({ id: schema.projectGithubConversionJobs.id })
            .from(schema.projectGithubConversionJobs)
            .where(
              and(
                eq(schema.projectGithubConversionJobs.projectId, projectId),
                inArray(schema.projectGithubConversionJobs.state, [
                  "queued",
                  "running",
                  "blocked",
                ]),
              ),
            )
            .limit(1),
          transaction
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.ownerId, ownerId),
                eq(
                  schema.projects.githubRepositoryId,
                  input.repository.repositoryId,
                ),
              ),
            )
            .limit(1),
          transaction
            .select({ id: schema.workflowRuns.id })
            .from(schema.workflowRuns)
            .where(
              and(
                eq(schema.workflowRuns.projectId, projectId),
                inArray(schema.workflowRuns.status, [
                  ...ACTIVE_WORKFLOW_STATES,
                ]),
              ),
            )
            .limit(1),
          transaction
            .select({ id: schema.projectSources.id })
            .from(schema.projectSources)
            .where(
              and(
                eq(schema.projectSources.projectId, projectId),
                eq(schema.projectSources.workerId, workerId),
                eq(schema.projectSources.sourceKind, "folder"),
                isNull(schema.projectSources.removedAt),
              ),
            )
            .limit(1),
        ]);
      if (activeJobs[0]) {
        throw new ProjectGithubConversionJobConflictError(
          "A GitHub conversion is already active for this project.",
        );
      }
      if (collisions[0]) {
        throw new ProjectGithubConversionJobConflictError(
          "This GitHub repository is already bound to another Cantrip project.",
        );
      }
      if (activeWorkflows[0]) {
        throw new ProjectGithubConversionJobConflictError(
          "Wait for active project workflows to finish before converting.",
        );
      }
      if (!sources[0]) {
        throw new ProjectGithubConversionJobConflictError(
          "The project no longer has its owning folder source.",
        );
      }
      const rows = await transaction
        .insert(schema.projectGithubConversionJobs)
        .values({
          id: randomUUID(),
          ownerId,
          projectId,
          projectSourceId: sources[0].id,
          workerId,
          repositoryId: input.repository.repositoryId,
          repositoryFullName: input.repository.nameWithOwner,
          repositoryUrl: input.repository.url,
          confirmationToken: input.confirmationToken,
          initialCommitMessage: input.initialCommit?.message ?? null,
          state: "queued",
          stateRevision: 1,
          attempt: 0,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rows[0]!;
    });
    return toJob(row);
  }

  async claimNext(): Promise<ClaimedProjectGithubConversionJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ job: schema.projectGithubConversionJobs })
        .from(schema.projectGithubConversionJobs)
        .innerJoin(
          schema.projects,
          and(
            eq(
              schema.projects.id,
              schema.projectGithubConversionJobs.projectId,
            ),
            eq(schema.projects.originKind, "managed-folder"),
          ),
        )
        .where(
          and(
            eq(schema.projectGithubConversionJobs.state, "queued"),
            lte(schema.projectGithubConversionJobs.availableAt, now),
          ),
        )
        .orderBy(
          asc(schema.projectGithubConversionJobs.availableAt),
          asc(schema.projectGithubConversionJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0]?.job;
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.projectGithubConversionJobs)
        .set({
          state: "running",
          stateRevision: candidate.stateRevision + 1,
          attempt: candidate.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(
            now.getTime() + PROJECT_GITHUB_CONVERSION_JOB_LEASE_MS,
          ),
          startedAt: candidate.startedAt ?? now,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectGithubConversionJobs.id, candidate.id),
            eq(schema.projectGithubConversionJobs.state, "queued"),
            eq(
              schema.projectGithubConversionJobs.stateRevision,
              candidate.stateRevision,
            ),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      return {
        commandId,
        confirmationToken: rows[0].confirmationToken,
        initialCommit: rows[0].initialCommitMessage
          ? { message: rows[0].initialCommitMessage }
          : null,
        job: toJob(rows[0]),
        ownerId: rows[0].ownerId,
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
      .update(schema.projectGithubConversionJobs)
      .set({
        leaseExpiresAt: new Date(
          now.getTime() + PROJECT_GITHUB_CONVERSION_JOB_LEASE_MS,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectGithubConversionJobs.id, jobId),
          eq(schema.projectGithubConversionJobs.state, "running"),
          eq(schema.projectGithubConversionJobs.commandId, commandId),
          eq(schema.projectGithubConversionJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.projectGithubConversionJobs.id });
    return rows.length === 1;
  }

  async block(
    jobId: string,
    commandId: string,
    error: ProjectGithubConversionError,
  ): Promise<ProjectGithubConversionJobSummary> {
    return this.settle(jobId, commandId, "blocked", error);
  }

  async fail(
    jobId: string,
    commandId: string,
    error: ProjectGithubConversionError,
  ): Promise<ProjectGithubConversionJobSummary> {
    return this.settle(jobId, commandId, "failed", error);
  }

  private async settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: ProjectGithubConversionError,
  ): Promise<ProjectGithubConversionJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.projectGithubConversionJobs)
      .set({
        state,
        stateRevision: sql`${schema.projectGithubConversionJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        completedAt: state === "failed" ? now : null,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        errorRetryable: error.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectGithubConversionJobs.id, jobId),
          eq(schema.projectGithubConversionJobs.state, "running"),
          eq(schema.projectGithubConversionJobs.commandId, commandId),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new ProjectGithubConversionJobStaleAttemptError(
        "The GitHub conversion attempt is no longer current.",
      );
    }
    return toJob(rows[0]);
  }

  async complete(
    jobId: string,
    commandId: string,
    result: ProjectGithubConversionReady,
  ): Promise<ProjectGithubConversionJobSummary> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(schema.projectGithubConversionJobs)
        .where(eq(schema.projectGithubConversionJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = jobs[0];
      if (
        !job ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== result.attempt ||
        job.id !== result.jobId
      ) {
        throw new ProjectGithubConversionJobStaleAttemptError(
          "The GitHub conversion completion is no longer current.",
        );
      }
      if (
        job.repositoryId !== result.repository.repositoryId ||
        job.repositoryFullName.toLowerCase() !==
          result.repository.nameWithOwner.toLowerCase() ||
        job.repositoryUrl !== result.repository.url
      ) {
        throw new ProjectGithubConversionJobConflictError(
          "The worker returned a different GitHub repository identity.",
        );
      }
      const [projects, sources, collisions] = await Promise.all([
        transaction
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, job.projectId),
              eq(schema.projects.ownerId, job.ownerId),
            ),
          )
          .for("update")
          .limit(1),
        transaction
          .select()
          .from(schema.projectSources)
          .where(
            and(
              eq(schema.projectSources.projectId, job.projectId),
              eq(schema.projectSources.id, job.projectSourceId),
              eq(schema.projectSources.workerId, job.workerId),
              eq(schema.projectSources.sourceKind, "folder"),
              isNull(schema.projectSources.removedAt),
            ),
          )
          .for("update")
          .limit(1),
        transaction
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.ownerId, job.ownerId),
              eq(schema.projects.githubRepositoryId, job.repositoryId),
            ),
          )
          .limit(1),
      ]);
      const project = projects[0];
      const source = sources[0];
      if (!project || project.originKind !== "managed-folder" || !source) {
        throw new ProjectGithubConversionJobConflictError(
          "The folder project changed before conversion completed.",
        );
      }
      if (collisions[0] && collisions[0].id !== project.id) {
        throw new ProjectGithubConversionJobConflictError(
          "The GitHub repository became bound to another Cantrip project.",
        );
      }
      const roots = await transaction
        .select()
        .from(schema.projectWorktrees)
        .where(
          and(
            eq(schema.projectWorktrees.projectSourceId, source.id),
            eq(schema.projectWorktrees.rootKind, "folder-root"),
            eq(schema.projectWorktrees.isPrimary, true),
            eq(schema.projectWorktrees.isDefault, true),
          ),
        )
        .for("update")
        .limit(1);
      const root = roots[0];
      if (
        !root ||
        source.absolutePath !== result.path ||
        root.absolutePath !== result.path
      ) {
        throw new ProjectGithubConversionJobConflictError(
          "The Primary folder path changed before conversion completed.",
        );
      }
      await transaction
        .update(schema.projectSources)
        .set({
          sourceKind: "git",
          repositoryFingerprint: result.repositoryFingerprint,
          displayPath: result.displayPath,
          updatedAt: now,
        })
        .where(eq(schema.projectSources.id, source.id));
      await transaction
        .update(schema.projectWorktrees)
        .set({
          rootKind: "git-worktree",
          displayPath: result.displayPath,
          branch: result.branch,
          head: result.head,
          detached: false,
          lifecycleState: "ready",
          lastScannedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.projectWorktrees.id, root.id));
      await transaction
        .update(schema.projects)
        .set({
          originKind: "github",
          folderManagement: null,
          githubRepositoryId: result.repository.repositoryId,
          githubRepositoryFullName: result.repository.nameWithOwner,
          githubRepositoryUrl: result.repository.url,
          worktreePolicy: result.worktreePolicy,
          setupStatus: "ready",
          setupError: null,
          updatedAt: now,
        })
        .where(eq(schema.projects.id, project.id));
      const completed = await transaction
        .update(schema.projectGithubConversionJobs)
        .set({
          state: "succeeded",
          stateRevision: sql`${schema.projectGithubConversionJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectGithubConversionJobs.id, job.id),
            eq(schema.projectGithubConversionJobs.commandId, commandId),
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
  ): Promise<ProjectGithubConversionJobSummary | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.projectGithubConversionJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.projectGithubConversionJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectGithubConversionJobs.ownerId, ownerId),
          eq(schema.projectGithubConversionJobs.projectId, projectId),
          eq(schema.projectGithubConversionJobs.stateRevision, stateRevision),
          eq(schema.projectGithubConversionJobs.state, "blocked"),
          eq(schema.projectGithubConversionJobs.errorRetryable, true),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    const rows = await this.database
      .update(schema.projectGithubConversionJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.projectGithubConversionJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        force
          ? eq(schema.projectGithubConversionJobs.state, "running")
          : and(
              eq(schema.projectGithubConversionJobs.state, "running"),
              or(
                isNull(schema.projectGithubConversionJobs.leaseExpiresAt),
                lte(schema.projectGithubConversionJobs.leaseExpiresAt, now),
              ),
            ),
      )
      .returning({ id: schema.projectGithubConversionJobs.id });
    return rows.length;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.projectGithubConversionJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.projectGithubConversionJobs.stateRevision} + 1`,
        availableAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectGithubConversionJobs.workerId, workerId),
          eq(schema.projectGithubConversionJobs.state, "blocked"),
          eq(schema.projectGithubConversionJobs.errorRetryable, true),
        ),
      )
      .returning({ id: schema.projectGithubConversionJobs.id });
    return rows.length;
  }
}
