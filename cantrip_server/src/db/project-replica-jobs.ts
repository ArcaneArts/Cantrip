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
  type ProjectReplicaRemoveCreate,
  type ProjectReplicaRemoveResult,
  type ProjectReplicaSynchronizeCreate,
  type ProjectReplicaSynchronizeResult,
} from "@cantrip/protocol";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
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

export interface ProjectReplicaOperationContext {
  primaryWorktreeId: string;
  sourcePath: string;
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
    synchronizationPolicy: row.synchronizationPolicy,
    deleteLocalFiles: row.deleteLocalFiles,
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

function replicaOperationFingerprint(
  kind: "synchronize" | "remove",
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaSynchronizeCreate | ProjectReplicaRemoveCreate,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, projectId, projectReplicaId, ...input }))
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
              isNull(schema.projectSources.removedAt),
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

  async createSynchronize(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
    input: ProjectReplicaSynchronizeCreate,
  ): Promise<ProjectReplicaJobSummary> {
    return this.createReplicaOperation(
      ownerId,
      projectId,
      projectReplicaId,
      "synchronize",
      input,
    );
  }

  async createRemove(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
    input: ProjectReplicaRemoveCreate,
  ): Promise<ProjectReplicaJobSummary> {
    return this.createReplicaOperation(
      ownerId,
      projectId,
      projectReplicaId,
      "remove",
      input,
    );
  }

  private async createReplicaOperation(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
    kind: "synchronize" | "remove",
    input: ProjectReplicaSynchronizeCreate | ProjectReplicaRemoveCreate,
  ): Promise<ProjectReplicaJobSummary> {
    const fingerprint = replicaOperationFingerprint(
      kind,
      projectId,
      projectReplicaId,
      input,
    );
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
            source: schema.projectSources,
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
            schema.workers,
            and(
              eq(schema.workers.id, schema.projectSources.workerId),
              isNull(schema.workers.unlinkedAt),
            ),
          )
          .where(
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projectSources.id, projectReplicaId),
              isNull(schema.projectSources.removedAt),
            ),
          )
          .for("update")
          .limit(1);
        const target = targets[0];
        if (!target) {
          throw new ProjectReplicaJobNotFoundError(
            "Project replica or target worker was not found.",
          );
        }
        if (!target.project.githubRepositoryFullName) {
          throw new ProjectReplicaJobConflictError(
            "Only GitHub-backed project replicas support this operation.",
          );
        }
        if (kind === "remove") {
          const activeReplicas = await transaction
            .select({ id: schema.projectSources.id })
            .from(schema.projectSources)
            .where(
              and(
                eq(schema.projectSources.projectId, projectId),
                isNull(schema.projectSources.removedAt),
              ),
            );
          if (activeReplicas.length <= 1) {
            throw new ProjectReplicaJobConflictError(
              "The last project replica cannot be removed. Remove the project instead.",
            );
          }
        }
        const active = await transaction
          .select({ id: schema.projectReplicaJobs.id })
          .from(schema.projectReplicaJobs)
          .where(
            and(
              kind === "remove"
                ? or(
                    eq(
                      schema.projectReplicaJobs.projectReplicaId,
                      projectReplicaId,
                    ),
                    and(
                      eq(schema.projectReplicaJobs.projectId, projectId),
                      eq(schema.projectReplicaJobs.kind, "remove"),
                    ),
                  )
                : eq(
                    schema.projectReplicaJobs.projectReplicaId,
                    projectReplicaId,
                  ),
              inArray(schema.projectReplicaJobs.state, [...ACTIVE_STATES]),
            ),
          )
          .limit(1);
        if (active[0]) {
          throw new ProjectReplicaJobConflictError(
            "Another operation is already active for this replica.",
          );
        }
        const synchronizeInput =
          kind === "synchronize"
            ? (input as ProjectReplicaSynchronizeCreate)
            : null;
        const removeInput =
          kind === "remove" ? (input as ProjectReplicaRemoveCreate) : null;
        const rows = await transaction
          .insert(schema.projectReplicaJobs)
          .values({
            id: randomUUID(),
            ownerId,
            projectId,
            projectReplicaId,
            workerId: target.source.workerId,
            kind,
            state: "queued",
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: fingerprint,
            repository: target.project.githubRepositoryFullName,
            expectedRevision: synchronizeInput?.expectedRevision ?? null,
            synchronizationPolicy: synchronizeInput?.policy ?? null,
            deleteLocalFiles: removeInput?.deleteLocalFiles ?? null,
            progress: progress(
              "queued",
              0,
              `Waiting to ${kind} the replica.`,
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
          : "Another operation is already active for this replica.",
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

  async operationContext(
    jobId: string,
    commandId: string,
  ): Promise<ProjectReplicaOperationContext | null> {
    const rows = await this.database
      .select({
        primaryWorktreeId: schema.projectWorktrees.id,
        sourcePath: schema.projectSources.absolutePath,
      })
      .from(schema.projectReplicaJobs)
      .innerJoin(
        schema.projectSources,
        and(
          eq(
            schema.projectSources.id,
            schema.projectReplicaJobs.projectReplicaId,
          ),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
          eq(schema.projectWorktrees.isPrimary, true),
        ),
      )
      .where(
        and(
          eq(schema.projectReplicaJobs.id, jobId),
          eq(schema.projectReplicaJobs.commandId, commandId),
          eq(schema.projectReplicaJobs.state, "running"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async removalBlocker(
    projectReplicaId: string,
    currentJobId: string,
  ): Promise<string | null> {
    const worktrees = await this.database
      .select({ id: schema.projectWorktrees.id })
      .from(schema.projectWorktrees)
      .where(eq(schema.projectWorktrees.projectSourceId, projectReplicaId));
    if (worktrees.length !== 1) {
      return "Remove managed worktrees from this replica before removing it.";
    }
    const worktreeId = worktrees[0]?.id;
    if (!worktreeId) return "The replica has no Primary worktree record.";

    const [chats, terminals, explorers, codeTabs, views, lanes, leases, jobs] =
      await Promise.all([
        this.database
          .select({ id: schema.chats.id })
          .from(schema.chats)
          .where(eq(schema.chats.activeWorktreeId, worktreeId))
          .limit(1),
        this.database
          .select({ id: schema.terminals.id })
          .from(schema.terminals)
          .where(eq(schema.terminals.worktreeId, worktreeId))
          .limit(1),
        this.database
          .select({ id: schema.explorers.id })
          .from(schema.explorers)
          .where(eq(schema.explorers.worktreeId, worktreeId))
          .limit(1),
        this.database
          .select({ id: schema.codeTabs.id })
          .from(schema.codeTabs)
          .where(eq(schema.codeTabs.worktreeId, worktreeId))
          .limit(1),
        this.database
          .select({ id: schema.projectViews.id })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.worktreeId, worktreeId))
          .limit(1),
        this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.worktreeId, worktreeId),
              sql`${schema.chatExecutionLanes.state} <> 'released'`,
            ),
          )
          .limit(1),
        this.database
          .select({ id: schema.workflowWorktreeLeases.id })
          .from(schema.workflowWorktreeLeases)
          .where(
            and(
              eq(schema.workflowWorktreeLeases.worktreeId, worktreeId),
              sql`${schema.workflowWorktreeLeases.state} <> 'released'`,
            ),
          )
          .limit(1),
        this.database
          .select({ id: schema.projectReplicaJobs.id })
          .from(schema.projectReplicaJobs)
          .where(
            and(
              eq(schema.projectReplicaJobs.projectReplicaId, projectReplicaId),
              sql`${schema.projectReplicaJobs.id} <> ${currentJobId}`,
              inArray(schema.projectReplicaJobs.state, [...ACTIVE_STATES]),
            ),
          )
          .limit(1),
      ]);
    if (chats[0]) return "A chat is still assigned to this replica.";
    if (terminals[0]) return "A terminal is still assigned to this replica.";
    if (explorers[0]) return "An Explorer is still assigned to this replica.";
    if (codeTabs[0]) return "A Code tab is still assigned to this replica.";
    if (views[0]) return "A project view is still assigned to this replica.";
    if (lanes[0]) return "An execution lane is still using this replica.";
    if (leases[0]) return "A workflow lease is still using this replica.";
    if (jobs[0]) return "Another replica job is still active.";
    return null;
  }

  async markRemovalStarted(projectReplicaId: string): Promise<boolean> {
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({ lifecycleState: "removing", updatedAt: new Date() })
      .where(
        and(
          eq(schema.projectWorktrees.projectSourceId, projectReplicaId),
          eq(schema.projectWorktrees.isPrimary, true),
          inArray(schema.projectWorktrees.lifecycleState, [
            "ready",
            "removing",
          ]),
        ),
      )
      .returning({ id: schema.projectWorktrees.id });
    return rows.length === 1;
  }

  async restoreRemovalReady(projectReplicaId: string): Promise<void> {
    await this.database
      .update(schema.projectWorktrees)
      .set({ lifecycleState: "ready", updatedAt: new Date() })
      .where(
        and(
          eq(schema.projectWorktrees.projectSourceId, projectReplicaId),
          eq(schema.projectWorktrees.isPrimary, true),
          eq(schema.projectWorktrees.lifecycleState, "removing"),
        ),
      );
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
            `Dispatching replica ${candidate.kind}.`,
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
          cancellationUnsafeAt: sql`CASE WHEN ${schema.projectReplicaJobs.kind} = 'provision' THEN NULL ELSE ${schema.projectReplicaJobs.cancellationUnsafeAt} END`,
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
        .where(
          and(
            eq(schema.projectSources.projectId, updated[0].projectId),
            isNull(schema.projectSources.removedAt),
          ),
        )
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
            isNull(schema.projectSources.removedAt),
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

  async completeSynchronize(
    jobId: string,
    commandId: string,
    result: Extract<ProjectReplicaSynchronizeResult, { status: "ready" }>,
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
        job.kind !== "synchronize" ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== result.attempt ||
        job.id !== result.jobId ||
        !job.projectReplicaId ||
        job.expectedRevision !== result.resolvedRevision
      ) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The replica synchronization result does not match the active attempt.",
        );
      }
      const source = await transaction
        .select({ path: schema.projectSources.absolutePath })
        .from(schema.projectSources)
        .where(
          and(
            eq(schema.projectSources.id, job.projectReplicaId),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!source[0] || source[0].path !== result.path) {
        throw new ProjectReplicaJobConflictError(
          "The worker synchronized a different replica path.",
        );
      }
      await transaction
        .update(schema.projectWorktrees)
        .set({
          branch: result.branch,
          detached: result.branch === null,
          head: result.resolvedRevision,
          lifecycleState: "ready",
          lastScannedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectWorktrees.projectSourceId, job.projectReplicaId),
            eq(schema.projectWorktrees.isPrimary, true),
          ),
        );
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "succeeded",
          stateRevision: job.stateRevision + 1,
          resolvedRevision: result.resolvedRevision,
          commandId: null,
          leaseExpiresAt: null,
          cancellationUnsafeAt: null,
          progress: progress(
            "succeeded",
            100,
            result.changed
              ? "Replica fast-forwarded to the expected revision."
              : "Replica already matches the expected revision.",
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
          "The replica synchronization attempt is no longer current.",
        );
      }
      return updated[0];
    });
    return toJob(completed);
  }

  async completeRemove(
    jobId: string,
    commandId: string,
    result: Extract<ProjectReplicaRemoveResult, { status: "removed" }>,
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
        job.kind !== "remove" ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.attempt !== result.attempt ||
        job.id !== result.jobId ||
        !job.projectReplicaId ||
        job.deleteLocalFiles !== result.localFilesDeleted
      ) {
        throw new ProjectReplicaJobStaleAttemptError(
          "The replica removal result does not match the active attempt.",
        );
      }
      const source = await transaction
        .select({ path: schema.projectSources.absolutePath })
        .from(schema.projectSources)
        .where(
          and(
            eq(schema.projectSources.id, job.projectReplicaId),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!source[0] || source[0].path !== result.path) {
        throw new ProjectReplicaJobConflictError(
          "The worker removed a different replica path.",
        );
      }
      await transaction
        .update(schema.projectSources)
        .set({ removedAt: now, updatedAt: now })
        .where(eq(schema.projectSources.id, job.projectReplicaId));
      await transaction
        .update(schema.projectWorktrees)
        .set({ lifecycleState: "missing", updatedAt: now })
        .where(
          eq(schema.projectWorktrees.projectSourceId, job.projectReplicaId),
        );
      const updated = await transaction
        .update(schema.projectReplicaJobs)
        .set({
          state: "succeeded",
          stateRevision: job.stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          cancellationUnsafeAt: null,
          progress: progress(
            "succeeded",
            100,
            result.localFilesDeleted
              ? "Replica local files were safely removed."
              : "Replica was removed from Cantrip; local files were retained.",
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
          "The replica removal attempt is no longer current.",
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
          .where(
            and(
              eq(schema.projectSources.projectId, updated[0].projectId),
              isNull(schema.projectSources.removedAt),
            ),
          )
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
            isNull(schema.projectReplicaJobs.cancellationUnsafeAt),
          ),
        )
        .returning();
      if (!updated[0]) return null;
      const readyReplica = await transaction
        .select({ id: schema.projectSources.id })
        .from(schema.projectSources)
        .where(
          and(
            eq(schema.projectSources.projectId, updated[0].projectId),
            isNull(schema.projectSources.removedAt),
          ),
        )
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
          .where(
            and(
              eq(schema.projectSources.projectId, projectId),
              isNull(schema.projectSources.removedAt),
            ),
          )
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
