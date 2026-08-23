import { randomUUID } from "node:crypto";

import {
  worktreeSetupJobSummarySchema,
  type WorkerRunSetupPublicStatus,
  type WorktreeSetupJobError,
  type WorktreeSetupJobSummary,
} from "@cantrip/protocol";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type JobRow = typeof schema.worktreeSetupJobs.$inferSelect;

export const WORKTREE_SETUP_JOB_LEASE_MS = 2 * 60_000;

export class WorktreeSetupJobStaleAttemptError extends Error {}

export interface ClaimedWorktreeSetupJob {
  commandId: string;
  job: WorktreeSetupJobSummary;
  ownerId: string;
  sourcePath: string;
  worktreePath: string;
}

function toJob(row: JobRow): WorktreeSetupJobSummary {
  return worktreeSetupJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    workerId: row.workerId,
    configurationRevision: row.configurationRevision,
    state: row.state,
    stateRevision: row.stateRevision,
    attempt: row.attempt,
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

export class WorktreeSetupJobRepository {
  constructor(private readonly database: Database) {}

  async get(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeSetupJobSummary | null> {
    const rows = await this.database
      .select({ job: schema.worktreeSetupJobs })
      .from(schema.worktreeSetupJobs)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.worktreeSetupJobs.projectId),
      )
      .where(
        and(
          eq(schema.worktreeSetupJobs.ownerId, ownerId),
          eq(schema.worktreeSetupJobs.projectId, projectId),
          eq(schema.worktreeSetupJobs.worktreeId, worktreeId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0].job) : null;
  }

  async initialize(input: {
    configurationRevision: string | null;
    error?: WorktreeSetupJobError;
    ownerId: string;
    projectId: string;
    queued: boolean;
    workerId: string;
    worktreeId: string;
  }): Promise<{ created: boolean; job: WorktreeSetupJobSummary }> {
    const now = new Date();
    const state = input.error
      ? "failed"
      : input.queued
        ? "queued"
        : "succeeded";
    const lifecycleState = input.error
      ? "setup-failed"
      : input.queued
        ? "preparing"
        : "ready";
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(schema.worktreeSetupJobs)
        .values({
          id: randomUUID(),
          ownerId: input.ownerId,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          workerId: input.workerId,
          configurationRevision: input.configurationRevision,
          state,
          completedAt: state === "queued" ? null : now,
          lastErrorCode: input.error?.code ?? null,
          lastErrorMessage: input.error?.message ?? null,
          errorRetryable: input.error?.retryable ?? null,
        })
        .onConflictDoNothing({ target: schema.worktreeSetupJobs.worktreeId })
        .returning();
      const created = rows[0];
      const selected =
        created ??
        (
          await transaction
            .select()
            .from(schema.worktreeSetupJobs)
            .where(eq(schema.worktreeSetupJobs.worktreeId, input.worktreeId))
            .limit(1)
        )[0];
      if (!selected || selected.ownerId !== input.ownerId) {
        throw new Error("The worktree setup job could not be initialized.");
      }
      if (created) {
        await transaction
          .update(schema.projectWorktrees)
          .set({ lifecycleState, updatedAt: now })
          .where(eq(schema.projectWorktrees.id, input.worktreeId));
      }
      return { created: Boolean(created), job: toJob(selected) };
    });
  }

  async claimNext(): Promise<ClaimedWorktreeSetupJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          job: schema.worktreeSetupJobs,
          sourcePath: schema.projectSources.absolutePath,
          worktreePath: schema.projectWorktrees.absolutePath,
        })
        .from(schema.worktreeSetupJobs)
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.worktreeSetupJobs.worktreeId),
        )
        .innerJoin(
          schema.projectSources,
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
        )
        .where(
          and(
            eq(schema.worktreeSetupJobs.state, "queued"),
            lte(schema.worktreeSetupJobs.availableAt, now),
            ne(schema.projectWorktrees.lifecycleState, "missing"),
          ),
        )
        .orderBy(
          asc(schema.worktreeSetupJobs.availableAt),
          asc(schema.worktreeSetupJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          state: "running",
          stateRevision: candidate.job.stateRevision + 1,
          attempt: candidate.job.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(now.getTime() + WORKTREE_SETUP_JOB_LEASE_MS),
          startedAt: now,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.worktreeSetupJobs.id, candidate.job.id),
            eq(schema.worktreeSetupJobs.state, "queued"),
            eq(
              schema.worktreeSetupJobs.stateRevision,
              candidate.job.stateRevision,
            ),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      return {
        commandId,
        ownerId: rows[0].ownerId,
        sourcePath: candidate.sourcePath,
        worktreePath: candidate.worktreePath,
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
      .update(schema.worktreeSetupJobs)
      .set({
        leaseExpiresAt: new Date(now.getTime() + WORKTREE_SETUP_JOB_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.worktreeSetupJobs.id, jobId),
          eq(schema.worktreeSetupJobs.state, "running"),
          eq(schema.worktreeSetupJobs.commandId, commandId),
          eq(schema.worktreeSetupJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.worktreeSetupJobs.id });
    return rows.length === 1;
  }

  async complete(
    jobId: string,
    commandId: string,
    status: WorkerRunSetupPublicStatus,
  ): Promise<WorktreeSetupJobSummary> {
    return this.finish(jobId, commandId, status, null);
  }

  async fail(
    jobId: string,
    commandId: string,
    status: WorkerRunSetupPublicStatus | null,
    error: WorktreeSetupJobError,
  ): Promise<WorktreeSetupJobSummary> {
    return this.finish(jobId, commandId, status, error);
  }

  private async finish(
    jobId: string,
    commandId: string,
    status: WorkerRunSetupPublicStatus | null,
    error: WorktreeSetupJobError | null,
  ): Promise<WorktreeSetupJobSummary> {
    const now = new Date();
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          state: error ? "failed" : "succeeded",
          stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: error?.code ?? null,
          lastErrorMessage: error?.message ?? null,
          errorRetryable: error?.retryable ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.worktreeSetupJobs.id, jobId),
            eq(schema.worktreeSetupJobs.state, "running"),
            eq(schema.worktreeSetupJobs.commandId, commandId),
            ...(status
              ? [eq(schema.worktreeSetupJobs.attempt, status.attempt)]
              : []),
          ),
        )
        .returning();
      const updated = rows[0];
      if (!updated) {
        throw new WorktreeSetupJobStaleAttemptError(
          "The worktree setup attempt is no longer current.",
        );
      }
      if (
        status &&
        (status.jobId !== updated.id ||
          status.projectId !== updated.projectId ||
          status.worktreeId !== updated.worktreeId ||
          status.configurationRevision !== updated.configurationRevision)
      ) {
        throw new WorktreeSetupJobStaleAttemptError(
          "The worker setup result does not match the durable job.",
        );
      }
      await transaction
        .update(schema.projectWorktrees)
        .set({
          lifecycleState: error ? "setup-failed" : "ready",
          updatedAt: now,
        })
        .where(eq(schema.projectWorktrees.id, updated.worktreeId));
      return updated;
    });
    return toJob(row);
  }

  async block(
    jobId: string,
    commandId: string,
    error: WorktreeSetupJobError,
  ): Promise<WorktreeSetupJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.worktreeSetupJobs)
      .set({
        state: "blocked",
        stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        errorRetryable: error.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.worktreeSetupJobs.id, jobId),
          eq(schema.worktreeSetupJobs.state, "running"),
          eq(schema.worktreeSetupJobs.commandId, commandId),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new WorktreeSetupJobStaleAttemptError(
        "The worktree setup attempt is no longer current.",
      );
    }
    return toJob(rows[0]);
  }

  async retry(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    stateRevision: number,
    configurationRevision: string | null,
    error: WorktreeSetupJobError | null,
  ): Promise<WorktreeSetupJobSummary | null> {
    const now = new Date();
    const state = error ? "failed" : "queued";
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          configurationRevision,
          state,
          stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          availableAt: now,
          completedAt: error ? now : null,
          lastErrorCode: error?.code ?? null,
          lastErrorMessage: error?.message ?? null,
          errorRetryable: error?.retryable ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.worktreeSetupJobs.ownerId, ownerId),
            eq(schema.worktreeSetupJobs.projectId, projectId),
            eq(schema.worktreeSetupJobs.worktreeId, worktreeId),
            eq(schema.worktreeSetupJobs.stateRevision, stateRevision),
            ne(schema.worktreeSetupJobs.state, "queued"),
            ne(schema.worktreeSetupJobs.state, "running"),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      await transaction
        .update(schema.projectWorktrees)
        .set({
          lifecycleState: error ? "setup-failed" : "preparing",
          updatedAt: now,
        })
        .where(eq(schema.projectWorktrees.id, worktreeId));
      return rows[0];
    });
    return row ? toJob(row) : null;
  }

  async markStale(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    stateRevision: number,
  ): Promise<WorktreeSetupJobSummary | null> {
    const now = new Date();
    const error: WorktreeSetupJobError = {
      code: "configuration-stale",
      message:
        "The project environment changed after this worktree was prepared. Retry setup before using it.",
      retryable: true,
    };
    const row = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          state: "stale",
          stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
          errorRetryable: true,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.worktreeSetupJobs.ownerId, ownerId),
            eq(schema.worktreeSetupJobs.projectId, projectId),
            eq(schema.worktreeSetupJobs.worktreeId, worktreeId),
            eq(schema.worktreeSetupJobs.stateRevision, stateRevision),
            ne(schema.worktreeSetupJobs.state, "queued"),
            ne(schema.worktreeSetupJobs.state, "running"),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      await transaction
        .update(schema.projectWorktrees)
        .set({ lifecycleState: "setup-stale", updatedAt: now })
        .where(eq(schema.projectWorktrees.id, worktreeId));
      return rows[0];
    });
    return row ? toJob(row) : null;
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
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
            ? eq(schema.worktreeSetupJobs.state, "running")
            : and(
                eq(schema.worktreeSetupJobs.state, "running"),
                or(
                  isNull(schema.worktreeSetupJobs.leaseExpiresAt),
                  lte(schema.worktreeSetupJobs.leaseExpiresAt, now),
                ),
              ),
        )
        .returning({ worktreeId: schema.worktreeSetupJobs.worktreeId });
      if (updated.length > 0) {
        await transaction
          .update(schema.projectWorktrees)
          .set({ lifecycleState: "preparing", updatedAt: now })
          .where(
            or(
              ...updated.map(({ worktreeId }) =>
                eq(schema.projectWorktrees.id, worktreeId),
              ),
            ),
          );
      }
      return updated;
    });
    return rows.length;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.worktreeSetupJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.worktreeSetupJobs.stateRevision} + 1`,
          availableAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.worktreeSetupJobs.workerId, workerId),
            eq(schema.worktreeSetupJobs.state, "blocked"),
            eq(schema.worktreeSetupJobs.errorRetryable, true),
          ),
        )
        .returning({ worktreeId: schema.worktreeSetupJobs.worktreeId });
      for (const { worktreeId } of updated) {
        await transaction
          .update(schema.projectWorktrees)
          .set({ lifecycleState: "preparing", updatedAt: now })
          .where(eq(schema.projectWorktrees.id, worktreeId));
      }
      return updated;
    });
    return rows.length;
  }
}
