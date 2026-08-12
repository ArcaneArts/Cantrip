import { createHash, randomUUID } from "node:crypto";

import {
  projectReplicaJobListSchema,
  projectReplicaJobSummarySchema,
  type ProjectReplicaJobError,
  type ProjectReplicaJobProgress,
  type ProjectReplicaJobProgressEvent,
  type ProjectReplicaJobSummary,
  type ProjectReplicaProvisionCreate,
  type ProjectReplicaProvisionResult,
} from "@cantrip/protocol";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type ProjectReplicaJobDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ProjectReplicaJobRow = typeof schema.projectReplicaJobs.$inferSelect;

const ACTIVE_STATES = ["queued", "running", "blocked"] as const;
const JOB_LEASE_MS = 15 * 60_000;

export class ProjectReplicaJobConflictError extends Error {}
export class ProjectReplicaJobNotFoundError extends Error {}
export class ProjectReplicaJobStaleAttemptError extends Error {}

export interface ClaimedProjectReplicaJob {
  commandId: string;
  job: ProjectReplicaJobSummary;
  ownerId: string;
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function progress(
  stage: string,
  percent: number,
  message: string,
  now = new Date(),
): ProjectReplicaJobProgress {
  return { stage, percent, message, updatedAt: toISOString(now) };
}

function toJob(row: ProjectReplicaJobRow): ProjectReplicaJobSummary {
  return projectReplicaJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    projectReplicaId: row.projectReplicaId,
    workerId: row.workerId,
    kind: row.kind,
    state: row.state,
    stateRevision: row.stateRevision,
    idempotencyKey: row.idempotencyKey,
    repository: row.repository,
    expectedRevision: row.expectedRevision,
    resolvedRevision: row.resolvedRevision,
    attempt: row.attempt,
    progress: row.progress,
    error:
      row.lastErrorCode && row.lastErrorMessage !== null
        ? {
            code: row.lastErrorCode,
            message: row.lastErrorMessage,
            retryable: row.errorRetryable ?? false,
          }
        : null,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
    startedAt: row.startedAt ? toISOString(row.startedAt) : null,
    cancellationUnsafeAt: row.cancellationUnsafeAt
      ? toISOString(row.cancellationUnsafeAt)
      : null,
    completedAt: row.completedAt ? toISOString(row.completedAt) : null,
  });
}

function provisionFingerprint(
  projectId: string,
  input: ProjectReplicaProvisionCreate,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "provision",
        projectId,
        workerId: input.workerId,
        expectedRevision: input.expectedRevision,
      }),
    )
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current !== "object") break;
    if ("code" in current && current.code === "23505") return true;
    if (
      current instanceof Error &&
      /duplicate key|unique constraint/iu.test(current.message)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export class ProjectReplicaJobRepository {
  constructor(private readonly database: ProjectReplicaJobDatabase) {}

  async createProvision(
    ownerId: string,
    projectId: string,
    input: ProjectReplicaProvisionCreate,
  ): Promise<ProjectReplicaJobSummary> {
    const fingerprint = provisionFingerprint(projectId, input);
    const existing = await this.database
      .select()
      .from(schema.projectReplicaJobs)
      .where(
        and(
          eq(schema.projectReplicaJobs.ownerId, ownerId),
          eq(schema.projectReplicaJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadFingerprint !== fingerprint) {
        throw new ProjectReplicaJobConflictError(
          "This idempotency key is already attached to a different replica request.",
        );
      }
      return toJob(existing[0]);
    }

    const now = new Date();
    try {
      const created = await this.database.transaction(async (transaction) => {
        const targets = await transaction
          .select({
            project: schema.projects,
            workerId: schema.workers.id,
          })
          .from(schema.projects)
          .innerJoin(
            schema.workers,
            and(
              eq(schema.workers.id, input.workerId),
              eq(schema.workers.ownerId, ownerId),
              isNull(schema.workers.unlinkedAt),
            ),
          )
          .where(
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .limit(1);
        const target = targets[0];
        if (!target) {
          throw new ProjectReplicaJobNotFoundError(
            "Project or target worker was not found.",
          );
        }
        if (!target.project.githubRepositoryFullName) {
          throw new ProjectReplicaJobConflictError(
            "Only GitHub-backed projects can provision worker replicas.",
          );
        }
        const replicas = await transaction
          .select({ id: schema.projectSources.id })
          .from(schema.projectSources)
          .where(
            and(
              eq(schema.projectSources.projectId, projectId),
              eq(schema.projectSources.workerId, input.workerId),
            ),
          )
          .limit(1);
        if (replicas[0]) {
          throw new ProjectReplicaJobConflictError(
            "This worker already has a replica of the project.",
          );
        }
        const active = await transaction
          .select({ id: schema.projectReplicaJobs.id })
          .from(schema.projectReplicaJobs)
          .where(
            and(
              eq(schema.projectReplicaJobs.projectId, projectId),
              eq(schema.projectReplicaJobs.workerId, input.workerId),
              eq(schema.projectReplicaJobs.kind, "provision"),
              inArray(schema.projectReplicaJobs.state, [...ACTIVE_STATES]),
            ),
          )
          .limit(1);
        if (active[0]) {
          throw new ProjectReplicaJobConflictError(
            "A replica provision job is already active for this worker.",
          );
        }
        const rows = await transaction
          .insert(schema.projectReplicaJobs)
          .values({
            id: randomUUID(),
            ownerId,
            projectId,
            workerId: input.workerId,
            kind: "provision",
            state: "queued",
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: fingerprint,
            repository: target.project.githubRepositoryFullName,
            expectedRevision: input.expectedRevision,
            progress: progress(
              "queued",
              0,
              "Waiting for the target worker.",
              now,
            ),
            availableAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return rows[0]!;
      });
      return toJob(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.database
        .select()
        .from(schema.projectReplicaJobs)
        .where(
          and(
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            eq(schema.projectReplicaJobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (raced[0]?.payloadFingerprint === fingerprint) return toJob(raced[0]);
      throw new ProjectReplicaJobConflictError(
        raced[0]
          ? "This idempotency key is already attached to a different replica request."
          : "A replica provision job is already active for this worker.",
      );
    }
  }

  async get(
    ownerId: string,
    jobId: string,
  ): Promise<ProjectReplicaJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectReplicaJobs)
      .where(
        and(
          eq(schema.projectReplicaJobs.id, jobId),
          eq(schema.projectReplicaJobs.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async list(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaJobSummary[] | null> {
    const owned = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    const rows = await this.database
      .select()
      .from(schema.projectReplicaJobs)
      .where(eq(schema.projectReplicaJobs.projectId, projectId))
      .orderBy(asc(schema.projectReplicaJobs.createdAt));
    return projectReplicaJobListSchema.parse(rows.map(toJob));
  }

  async recoverInterrupted(): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.projectReplicaJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.projectReplicaJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        cancellationUnsafeAt: null,
        availableAt: now,
        progress: progress(
          "queued",
          0,
          "Recovered after the server restarted.",
          now,
        ),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(eq(schema.projectReplicaJobs.state, "running"))
      .returning({ id: schema.projectReplicaJobs.id });
    return rows.length;
  }

  async claimNext(): Promise<ClaimedProjectReplicaJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(schema.projectReplicaJobs)
        .where(
          and(
            eq(schema.projectReplicaJobs.state, "queued"),
            lte(schema.projectReplicaJobs.availableAt, now),
          ),
        )
        .orderBy(
          asc(schema.projectReplicaJobs.availableAt),
          asc(schema.projectReplicaJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "running",
          stateRevision: candidate.stateRevision + 1,
          attempt: candidate.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
          startedAt: candidate.startedAt ?? now,
          cancellationUnsafeAt: now,
          progress: progress(
            "dispatching",
            5,
            "Dispatching exact-revision provisioning.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.id, candidate.id),
            eq(schema.projectReplicaJobs.state, "queued"),
            eq(
              schema.projectReplicaJobs.stateRevision,
              candidate.stateRevision,
            ),
          ),
        )
        .returning();
      if (!rows[0]) return null;
      return { ownerId: rows[0].ownerId, commandId, job: toJob(rows[0]) };
    });
  }

  async block(
    jobId: string,
    commandId: string,
    error: ProjectReplicaJobError,
  ): Promise<ProjectReplicaJobSummary> {
    return this.settle(jobId, commandId, "blocked", error);
  }

  async updateProgress(
    jobId: string,
    commandId: string,
    attempt: number,
    update: ProjectReplicaJobProgressEvent,
  ): Promise<ProjectReplicaJobSummary | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.projectReplicaJobs)
      .set({
        stateRevision: sql`${schema.projectReplicaJobs.stateRevision} + 1`,
        progress: { ...update, updatedAt: toISOString(now) },
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectReplicaJobs.id, jobId),
          eq(schema.projectReplicaJobs.state, "running"),
          eq(schema.projectReplicaJobs.commandId, commandId),
          eq(schema.projectReplicaJobs.attempt, attempt),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  async fail(
    jobId: string,
    commandId: string,
    error: ProjectReplicaJobError,
  ): Promise<ProjectReplicaJobSummary> {
    return this.settle(jobId, commandId, "failed", error);
  }

  private async settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: ProjectReplicaJobError,
  ): Promise<ProjectReplicaJobSummary> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state,
          stateRevision: sql`${schema.projectReplicaJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          cancellationUnsafeAt: null,
          completedAt: state === "failed" ? now : null,
          progress: progress(
            state,
            state === "failed" ? 100 : 0,
            error.message,
            now,
          ),
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
          errorRetryable: error.retryable,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.id, jobId),
            eq(schema.projectReplicaJobs.state, "running"),
            eq(schema.projectReplicaJobs.commandId, commandId),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The replica job attempt is no longer current.",
        );
      }
      const readyReplica = await transaction
        .select({ id: schema.projectSources.id })
        .from(schema.projectSources)
        .where(eq(schema.projectSources.projectId, updated[0].projectId))
        .limit(1);
      if (!readyReplica[0]) {
        await transaction
          .update(schema.projects)
          .set({
            setupStatus: "failed",
            setupError: error.message,
            updatedAt: now,
          })
          .where(eq(schema.projects.id, updated[0].projectId));
      }
      return updated[0];
    });
    return toJob(rows);
  }

  async completeProvision(
    jobId: string,
    commandId: string,
    result: Extract<ProjectReplicaProvisionResult, { status: "ready" }>,
  ): Promise<ProjectReplicaJobSummary> {
    const now = new Date();
    const completed = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.projectReplicaJobs)
        .where(eq(schema.projectReplicaJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = rows[0];
      if (
        !job ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== result.attempt
      ) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The replica job attempt is no longer current.",
        );
      }
      if (job.id !== result.jobId) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The worker completed a different replica job.",
        );
      }
      let sources = await transaction
        .select()
        .from(schema.projectSources)
        .where(
          and(
            eq(schema.projectSources.projectId, job.projectId),
            eq(schema.projectSources.workerId, job.workerId),
          ),
        )
        .limit(1);
      if (
        sources[0] &&
        (sources[0].absolutePath !== result.path ||
          sources[0].repositoryFingerprint !== result.repositoryFingerprint)
      ) {
        throw new ProjectReplicaJobConflictError(
          "The worker already has a different replica record for this project.",
        );
      }
      if (!sources[0]) {
        sources = await transaction
          .insert(schema.projectSources)
          .values({
            id: randomUUID(),
            projectId: job.projectId,
            workerId: job.workerId,
            absolutePath: result.path,
            displayPath: result.displayPath,
            repositoryFingerprint: result.repositoryFingerprint,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      }
      const source = sources[0]!;
      const primary = await transaction
        .select({ id: schema.projectWorktrees.id })
        .from(schema.projectWorktrees)
        .where(
          and(
            eq(schema.projectWorktrees.projectSourceId, source.id),
            eq(schema.projectWorktrees.isPrimary, true),
          ),
        )
        .limit(1);
      if (!primary[0]) {
        await transaction.insert(schema.projectWorktrees).values({
          id: randomUUID(),
          projectSourceId: source.id,
          workerId: job.workerId,
          name: "Primary",
          absolutePath: result.path,
          displayPath: result.displayPath,
          isPrimary: true,
          isDefault: true,
          origin: "cantrip",
          lifecycleState: "ready",
          branch: result.branch,
          head: result.resolvedRevision,
          detached: result.branch === null,
          lastScannedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      await transaction
        .update(schema.projects)
        .set({
          setupStatus: "ready",
          setupError: null,
          worktreePolicy:
            result.worktreePolicy ?? sql`${schema.projects.worktreePolicy}`,
          updatedAt: now,
        })
        .where(eq(schema.projects.id, job.projectId));
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          projectReplicaId: source.id,
          state: "succeeded",
          stateRevision: job.stateRevision + 1,
          resolvedRevision: result.resolvedRevision,
          commandId: null,
          leaseExpiresAt: null,
          cancellationUnsafeAt: null,
          progress: progress(
            "succeeded",
            100,
            "Replica is ready at the resolved revision.",
            now,
          ),
          completedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.id, job.id),
            eq(schema.projectReplicaJobs.commandId, commandId),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The replica job attempt is no longer current.",
        );
      }
      return updated[0];
    });
    return toJob(completed);
  }

  async retry(
    ownerId: string,
    jobId: string,
    stateRevision: number,
  ): Promise<ProjectReplicaJobSummary | null> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "queued",
          stateRevision: stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          cancellationUnsafeAt: null,
          availableAt: now,
          completedAt: null,
          progress: progress("queued", 0, "Retry requested.", now),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.id, jobId),
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            eq(schema.projectReplicaJobs.stateRevision, stateRevision),
            inArray(schema.projectReplicaJobs.state, ["blocked", "failed"]),
          ),
        )
        .returning();
      if (updated[0]) {
        const readyReplica = await transaction
          .select({ id: schema.projectSources.id })
          .from(schema.projectSources)
          .where(eq(schema.projectSources.projectId, updated[0].projectId))
          .limit(1);
        if (!readyReplica[0]) {
          await transaction
            .update(schema.projects)
            .set({ setupStatus: "cloning", setupError: null, updatedAt: now })
            .where(eq(schema.projects.id, updated[0].projectId));
        }
      }
      return updated[0] ?? null;
    });
    return rows ? toJob(rows) : null;
  }

  async cancel(
    ownerId: string,
    jobId: string,
    stateRevision: number,
  ): Promise<ProjectReplicaJobSummary | null> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "cancelled",
          stateRevision: stateRevision + 1,
          progress: progress(
            "cancelled",
            100,
            "Provisioning was cancelled.",
            now,
          ),
          completedAt: now,
          cancellationUnsafeAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.id, jobId),
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            eq(schema.projectReplicaJobs.stateRevision, stateRevision),
            inArray(schema.projectReplicaJobs.state, ["queued", "blocked"]),
          ),
        )
        .returning();
      if (!updated[0]) return null;
      const readyReplica = await transaction
        .select({ id: schema.projectSources.id })
        .from(schema.projectSources)
        .where(eq(schema.projectSources.projectId, updated[0].projectId))
        .limit(1);
      if (!readyReplica[0]) {
        await transaction
          .update(schema.projects)
          .set({
            setupStatus: "failed",
            setupError: "Replica provisioning was cancelled.",
            updatedAt: now,
          })
          .where(eq(schema.projects.id, updated[0].projectId));
      }
      return updated[0];
    });
    return rows ? toJob(rows) : null;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.projectReplicaJobs.stateRevision} + 1`,
          availableAt: now,
          cancellationUnsafeAt: null,
          progress: progress(
            "queued",
            0,
            "Target worker reconnected; retrying.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectReplicaJobs.workerId, workerId),
            eq(schema.projectReplicaJobs.state, "blocked"),
            eq(schema.projectReplicaJobs.errorRetryable, true),
          ),
        )
        .returning({
          id: schema.projectReplicaJobs.id,
          projectId: schema.projectReplicaJobs.projectId,
        });
      for (const projectId of new Set(updated.map((row) => row.projectId))) {
        const readyReplica = await transaction
          .select({ id: schema.projectSources.id })
          .from(schema.projectSources)
          .where(eq(schema.projectSources.projectId, projectId))
          .limit(1);
        if (!readyReplica[0]) {
          await transaction
            .update(schema.projects)
            .set({ setupStatus: "cloning", setupError: null, updatedAt: now })
            .where(eq(schema.projects.id, projectId));
        }
      }
      return updated;
    });
    return rows.length;
  }
}
