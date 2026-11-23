import { randomUUID } from "node:crypto";

import {
  standaloneChatRootJobSummarySchema,
  type StandaloneChatRootJobError,
  type StandaloneChatRootJobKind,
  type StandaloneChatRootJobSummary,
  type StandaloneChatScratchDeleteResult,
  type StandaloneChatScratchProvisionResult,
  type StandaloneChatScratchReconciliationTarget,
} from "@cantrip/protocol";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type JobRow = typeof schema.standaloneChatRootJobs.$inferSelect;

export const STANDALONE_CHAT_ROOT_JOB_LEASE_MS = 2 * 60_000;
const ROUTING_HANDLE_PATTERN = /^ctrr_[A-Za-z0-9_-]{43}$/u;

export class StandaloneChatRootJobConflictError extends Error {}
export class StandaloneChatRootJobStaleAttemptError extends Error {}

export interface ClaimedStandaloneChatRootJob {
  commandId: string;
  job: StandaloneChatRootJobSummary;
  ownerId: string;
}

function toJob(row: JobRow): StandaloneChatRootJobSummary {
  return standaloneChatRootJobSummarySchema.parse({
    id: row.id,
    rootId: row.rootId,
    chatId: row.chatId,
    workerId: row.workerId,
    kind: row.kind,
    state: row.state,
    stateRevision: row.stateRevision,
    attempt: row.attempt,
    error: row.lastErrorCode
      ? {
          code: row.lastErrorCode,
          retryable: row.errorRetryable ?? false,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

export class StandaloneChatRootJobRepository {
  constructor(private readonly database: Database) {}

  async get(
    ownerId: string,
    rootId: string,
    kind: StandaloneChatRootJobKind,
  ): Promise<StandaloneChatRootJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.standaloneChatRootJobs)
      .where(
        and(
          eq(schema.standaloneChatRootJobs.ownerId, ownerId),
          eq(schema.standaloneChatRootJobs.rootId, rootId),
          eq(schema.standaloneChatRootJobs.kind, kind),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async enqueueProvision(input: {
    id: string;
    ownerId: string;
    rootId: string;
    chatId: string;
    workerId: string;
  }): Promise<StandaloneChatRootJobSummary> {
    return this.#enqueue({ ...input, kind: "provision" });
  }

  async enqueueDelete(input: {
    id: string;
    ownerId: string;
    rootId: string;
    chatId: string;
    workerId: string;
  }): Promise<StandaloneChatRootJobSummary> {
    const job = await this.#enqueue({ ...input, kind: "delete" });
    await this.database
      .update(schema.standaloneChatRoots)
      .set({
        status: "deleting",
        deletionJobId: job.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.standaloneChatRoots.id, input.rootId),
          eq(schema.standaloneChatRoots.chatId, input.chatId),
          eq(schema.standaloneChatRoots.ownerId, input.ownerId),
          eq(schema.standaloneChatRoots.workerId, input.workerId),
        ),
      );
    await this.database
      .update(schema.standaloneChatRootJobs)
      .set({
        state: "failed",
        stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        lastErrorCode: "root-conflict",
        errorRetryable: false,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.standaloneChatRootJobs.rootId, input.rootId),
          eq(schema.standaloneChatRootJobs.kind, "provision"),
          inArray(schema.standaloneChatRootJobs.state, ["queued", "blocked"]),
        ),
      );
    return job;
  }

  async createDeletionTombstoneAndPurge(
    input: {
      id: string;
      ownerId: string;
      rootId: string;
      chatId: string;
      workerId: string;
    },
    options: { expiredBy?: Date } = {},
  ): Promise<StandaloneChatRootJobSummary> {
    return this.database.transaction(async (transaction) => {
      const roots = await transaction
        .select({ id: schema.standaloneChatRoots.id })
        .from(schema.standaloneChatRoots)
        .innerJoin(
          schema.chats,
          and(
            eq(schema.chats.id, schema.standaloneChatRoots.chatId),
            eq(schema.chats.ownerId, schema.standaloneChatRoots.ownerId),
          ),
        )
        .where(
          and(
            eq(schema.standaloneChatRoots.id, input.rootId),
            eq(schema.standaloneChatRoots.chatId, input.chatId),
            eq(schema.standaloneChatRoots.ownerId, input.ownerId),
            eq(schema.standaloneChatRoots.workerId, input.workerId),
            eq(schema.chats.contextKind, "standalone"),
            isNotNull(schema.chats.archivedAt),
            ...(options.expiredBy
              ? [
                  isNotNull(schema.standaloneChatRoots.archiveExpiresAt),
                  lte(
                    schema.standaloneChatRoots.archiveExpiresAt,
                    options.expiredBy,
                  ),
                ]
              : []),
          ),
        )
        .for("update")
        .limit(1);
      if (!roots[0]) {
        throw new StandaloneChatRootJobConflictError(
          "The standalone Chat scratch root no longer exists.",
        );
      }
      const inserted = await transaction
        .insert(schema.standaloneChatRootJobs)
        .values({ ...input, kind: "delete", state: "queued" })
        .onConflictDoNothing({
          target: [
            schema.standaloneChatRootJobs.rootId,
            schema.standaloneChatRootJobs.kind,
          ],
        })
        .returning();
      const existing = inserted[0]
        ? inserted[0]
        : (
            await transaction
              .select()
              .from(schema.standaloneChatRootJobs)
              .where(
                and(
                  eq(schema.standaloneChatRootJobs.rootId, input.rootId),
                  eq(schema.standaloneChatRootJobs.kind, "delete"),
                ),
              )
              .limit(1)
          )[0];
      if (!existing || !this.#sameIdentity(existing, input, "delete")) {
        throw new StandaloneChatRootJobConflictError(
          "The standalone Chat cleanup tombstone conflicts with an existing job.",
        );
      }
      await transaction
        .update(schema.standaloneChatRoots)
        .set({
          status: "deleting",
          deletionJobId: existing.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.standaloneChatRoots.id, input.rootId));
      await transaction
        .update(schema.standaloneChatRootJobs)
        .set({
          state: "failed",
          stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          lastErrorCode: "root-conflict",
          errorRetryable: false,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.standaloneChatRootJobs.rootId, input.rootId),
            eq(schema.standaloneChatRootJobs.kind, "provision"),
            inArray(schema.standaloneChatRootJobs.state, ["queued", "blocked"]),
          ),
        );
      await transaction
        .delete(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.chatId),
            eq(schema.chats.ownerId, input.ownerId),
            eq(schema.chats.contextKind, "standalone"),
          ),
        );
      return toJob(existing);
    });
  }

  async purgeExpiredArchivedChats(
    ownerId: string,
    now = new Date(),
  ): Promise<StandaloneChatRootJobSummary[]> {
    const candidates = await this.database
      .select({
        chatId: schema.standaloneChatRoots.chatId,
        ownerId: schema.standaloneChatRoots.ownerId,
        rootId: schema.standaloneChatRoots.id,
        workerId: schema.standaloneChatRoots.workerId,
      })
      .from(schema.standaloneChatRoots)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.standaloneChatRoots.chatId),
          eq(schema.chats.ownerId, schema.standaloneChatRoots.ownerId),
        ),
      )
      .where(
        and(
          eq(schema.standaloneChatRoots.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
          isNotNull(schema.standaloneChatRoots.archiveExpiresAt),
          lte(schema.standaloneChatRoots.archiveExpiresAt, now),
        ),
      );
    const jobs: StandaloneChatRootJobSummary[] = [];
    for (const candidate of candidates) {
      try {
        jobs.push(
          await this.createDeletionTombstoneAndPurge(
            { id: randomUUID(), ...candidate },
            { expiredBy: now },
          ),
        );
      } catch (error) {
        if (!(error instanceof StandaloneChatRootJobConflictError)) throw error;
      }
    }
    return jobs;
  }

  async purgeExpiredArchivedChatsForAllOwners(
    now = new Date(),
  ): Promise<Array<{ job: StandaloneChatRootJobSummary; ownerId: string }>> {
    const owners = await this.database
      .selectDistinct({ ownerId: schema.standaloneChatRoots.ownerId })
      .from(schema.standaloneChatRoots)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.standaloneChatRoots.chatId),
          eq(schema.chats.ownerId, schema.standaloneChatRoots.ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
          isNotNull(schema.standaloneChatRoots.archiveExpiresAt),
          lte(schema.standaloneChatRoots.archiveExpiresAt, now),
        ),
      );
    const changes: Array<{
      job: StandaloneChatRootJobSummary;
      ownerId: string;
    }> = [];
    for (const { ownerId } of owners) {
      const jobs = await this.purgeExpiredArchivedChats(ownerId, now);
      changes.push(...jobs.map((job) => ({ job, ownerId })));
    }
    return changes;
  }

  async #enqueue(input: {
    id: string;
    ownerId: string;
    rootId: string;
    chatId: string;
    workerId: string;
    kind: StandaloneChatRootJobKind;
  }): Promise<StandaloneChatRootJobSummary> {
    const inserted = await this.database
      .insert(schema.standaloneChatRootJobs)
      .values({ ...input, state: "queued" })
      .onConflictDoNothing({
        target: [
          schema.standaloneChatRootJobs.rootId,
          schema.standaloneChatRootJobs.kind,
        ],
      })
      .returning();
    const row = inserted[0]
      ? inserted[0]
      : (
          await this.database
            .select()
            .from(schema.standaloneChatRootJobs)
            .where(
              and(
                eq(schema.standaloneChatRootJobs.rootId, input.rootId),
                eq(schema.standaloneChatRootJobs.kind, input.kind),
              ),
            )
            .limit(1)
        )[0];
    if (!row || !this.#sameIdentity(row, input, input.kind)) {
      throw new StandaloneChatRootJobConflictError(
        "The standalone Chat scratch job conflicts with an existing identity.",
      );
    }
    return toJob(row);
  }

  #sameIdentity(
    row: JobRow,
    input: {
      id: string;
      ownerId: string;
      rootId: string;
      chatId: string;
      workerId: string;
    },
    kind: StandaloneChatRootJobKind,
  ): boolean {
    return (
      row.id === input.id &&
      row.ownerId === input.ownerId &&
      row.rootId === input.rootId &&
      row.chatId === input.chatId &&
      row.workerId === input.workerId &&
      row.kind === kind
    );
  }

  async claimNext(): Promise<ClaimedStandaloneChatRootJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const matchingRoot = transaction
        .select({ id: schema.standaloneChatRoots.id })
        .from(schema.standaloneChatRoots)
        .where(
          and(
            eq(
              schema.standaloneChatRoots.id,
              schema.standaloneChatRootJobs.rootId,
            ),
            eq(
              schema.standaloneChatRoots.chatId,
              schema.standaloneChatRootJobs.chatId,
            ),
            eq(
              schema.standaloneChatRoots.ownerId,
              schema.standaloneChatRootJobs.ownerId,
            ),
            eq(
              schema.standaloneChatRoots.workerId,
              schema.standaloneChatRootJobs.workerId,
            ),
            ne(schema.standaloneChatRoots.status, "deleting"),
          ),
        );
      const provisionJob = alias(
        schema.standaloneChatRootJobs,
        "unsettled_provision",
      );
      const unsettledProvision = transaction
        .select({ id: provisionJob.id })
        .from(provisionJob)
        .where(
          and(
            eq(provisionJob.rootId, schema.standaloneChatRootJobs.rootId),
            eq(provisionJob.kind, "provision"),
            inArray(provisionJob.state, ["queued", "running"]),
          ),
        );
      const candidates = await transaction
        .select({ job: schema.standaloneChatRootJobs })
        .from(schema.standaloneChatRootJobs)
        .where(
          and(
            eq(schema.standaloneChatRootJobs.state, "queued"),
            lte(schema.standaloneChatRootJobs.availableAt, now),
            or(
              and(
                eq(schema.standaloneChatRootJobs.kind, "provision"),
                exists(matchingRoot),
              ),
              and(
                eq(schema.standaloneChatRootJobs.kind, "delete"),
                notExists(unsettledProvision),
              ),
            ),
          ),
        )
        .orderBy(
          asc(schema.standaloneChatRootJobs.availableAt),
          asc(schema.standaloneChatRootJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.standaloneChatRootJobs)
        .set({
          state: "running",
          stateRevision: candidate.job.stateRevision + 1,
          attempt: candidate.job.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(
            now.getTime() + STANDALONE_CHAT_ROOT_JOB_LEASE_MS,
          ),
          startedAt: candidate.job.startedAt ?? now,
          completedAt: null,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.standaloneChatRootJobs.id, candidate.job.id),
            eq(schema.standaloneChatRootJobs.state, "queued"),
            eq(
              schema.standaloneChatRootJobs.stateRevision,
              candidate.job.stateRevision,
            ),
          ),
        )
        .returning();
      return rows[0]
        ? { ownerId: rows[0].ownerId, commandId, job: toJob(rows[0]) }
        : null;
    });
  }

  async renewLease(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.standaloneChatRootJobs)
      .set({
        leaseExpiresAt: new Date(
          now.getTime() + STANDALONE_CHAT_ROOT_JOB_LEASE_MS,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.standaloneChatRootJobs.id, jobId),
          eq(schema.standaloneChatRootJobs.state, "running"),
          eq(schema.standaloneChatRootJobs.commandId, commandId),
          eq(schema.standaloneChatRootJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.standaloneChatRootJobs.id });
    return rows.length === 1;
  }

  async block(
    jobId: string,
    commandId: string,
    error: StandaloneChatRootJobError,
  ): Promise<StandaloneChatRootJobSummary> {
    return this.#settle(jobId, commandId, "blocked", error);
  }

  async fail(
    jobId: string,
    commandId: string,
    error: StandaloneChatRootJobError,
  ): Promise<StandaloneChatRootJobSummary> {
    return this.#settle(jobId, commandId, "failed", error);
  }

  async #settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: StandaloneChatRootJobError,
  ): Promise<StandaloneChatRootJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.standaloneChatRootJobs)
      .set({
        state,
        stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        completedAt: state === "failed" ? now : null,
        lastErrorCode: error.code,
        errorRetryable: error.retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.standaloneChatRootJobs.id, jobId),
          eq(schema.standaloneChatRootJobs.state, "running"),
          eq(schema.standaloneChatRootJobs.commandId, commandId),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new StandaloneChatRootJobStaleAttemptError(
        "The standalone Chat scratch attempt is no longer current.",
      );
    }
    if (rows[0].kind === "provision") {
      await this.database
        .update(schema.standaloneChatRoots)
        .set({
          status: state === "blocked" ? "offline" : "failed",
          updatedAt: now,
        })
        .where(eq(schema.standaloneChatRoots.id, rows[0].rootId));
    }
    return toJob(rows[0]);
  }

  async completeProvision(
    jobId: string,
    commandId: string,
    result: StandaloneChatScratchProvisionResult,
  ): Promise<StandaloneChatRootJobSummary> {
    if (!ROUTING_HANDLE_PATTERN.test(result.path)) {
      throw new StandaloneChatRootJobConflictError(
        "The worker did not return an opaque scratch routing handle.",
      );
    }
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.standaloneChatRootJobs)
        .where(eq(schema.standaloneChatRootJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = rows[0];
      if (
        !job ||
        job.kind !== "provision" ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.id !== result.jobId ||
        job.attempt !== result.attempt ||
        job.rootId !== result.rootId ||
        job.chatId !== result.chatId
      ) {
        throw new StandaloneChatRootJobStaleAttemptError(
          "The standalone Chat provision completion is no longer current.",
        );
      }
      const roots = await transaction
        .update(schema.standaloneChatRoots)
        .set({
          protectedPathHandle: result.path,
          status: "ready",
          provisioningRevision: sql`${schema.standaloneChatRoots.provisioningRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.standaloneChatRoots.id, job.rootId),
            eq(schema.standaloneChatRoots.chatId, job.chatId),
            eq(schema.standaloneChatRoots.ownerId, job.ownerId),
            eq(schema.standaloneChatRoots.workerId, job.workerId),
          ),
        )
        .returning({ id: schema.standaloneChatRoots.id });
      if (!roots[0]) {
        throw new StandaloneChatRootJobConflictError(
          "The standalone Chat scratch root changed during provisioning.",
        );
      }
      return toJob(
        await this.#completeRow(transaction, job, commandId, new Date()),
      );
    });
  }

  async completeDelete(
    jobId: string,
    commandId: string,
    result: StandaloneChatScratchDeleteResult,
  ): Promise<StandaloneChatRootJobSummary> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.standaloneChatRootJobs)
        .where(eq(schema.standaloneChatRootJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = rows[0];
      if (
        !job ||
        job.kind !== "delete" ||
        job.state !== "running" ||
        job.commandId !== commandId ||
        job.id !== result.jobId ||
        job.attempt !== result.attempt ||
        job.rootId !== result.rootId ||
        job.chatId !== result.chatId
      ) {
        throw new StandaloneChatRootJobStaleAttemptError(
          "The standalone Chat deletion completion is no longer current.",
        );
      }
      return toJob(
        await this.#completeRow(transaction, job, commandId, new Date()),
      );
    });
  }

  async #completeRow(
    transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
    job: JobRow,
    commandId: string,
    now: Date,
  ): Promise<JobRow> {
    const completed = await transaction
      .update(schema.standaloneChatRootJobs)
      .set({
        state: "succeeded",
        stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        errorRetryable: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.standaloneChatRootJobs.id, job.id),
          eq(schema.standaloneChatRootJobs.commandId, commandId),
        ),
      )
      .returning();
    if (!completed[0]) {
      throw new StandaloneChatRootJobStaleAttemptError(
        "The standalone Chat scratch completion lost its lease.",
      );
    }
    return completed[0];
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.standaloneChatRootJobs)
        .set({
          state: "queued",
          stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          availableAt: now,
          lastErrorCode: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          force
            ? eq(schema.standaloneChatRootJobs.state, "running")
            : and(
                eq(schema.standaloneChatRootJobs.state, "running"),
                or(
                  isNull(schema.standaloneChatRootJobs.leaseExpiresAt),
                  lte(schema.standaloneChatRootJobs.leaseExpiresAt, now),
                ),
              ),
        )
        .returning({ id: schema.standaloneChatRootJobs.id });
      const matchingRoot = transaction
        .select({ id: schema.standaloneChatRoots.id })
        .from(schema.standaloneChatRoots)
        .where(
          and(
            eq(
              schema.standaloneChatRoots.id,
              schema.standaloneChatRootJobs.rootId,
            ),
            eq(
              schema.standaloneChatRoots.chatId,
              schema.standaloneChatRootJobs.chatId,
            ),
            eq(
              schema.standaloneChatRoots.ownerId,
              schema.standaloneChatRootJobs.ownerId,
            ),
            eq(
              schema.standaloneChatRoots.workerId,
              schema.standaloneChatRootJobs.workerId,
            ),
            ne(schema.standaloneChatRoots.status, "deleting"),
          ),
        );
      await transaction
        .update(schema.standaloneChatRootJobs)
        .set({
          state: "failed",
          stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          lastErrorCode: "root-conflict",
          errorRetryable: false,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.standaloneChatRootJobs.kind, "provision"),
            eq(schema.standaloneChatRootJobs.state, "queued"),
            notExists(matchingRoot),
          ),
        );
      return rows.length;
    });
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.standaloneChatRootJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.standaloneChatRootJobs.stateRevision} + 1`,
        availableAt: now,
        lastErrorCode: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.standaloneChatRootJobs.workerId, workerId),
          eq(schema.standaloneChatRootJobs.state, "blocked"),
          eq(schema.standaloneChatRootJobs.errorRetryable, true),
        ),
      )
      .returning({ id: schema.standaloneChatRootJobs.id });
    return rows.length;
  }

  async reconciliationTargets(
    workerId: string,
  ): Promise<StandaloneChatScratchReconciliationTarget[]> {
    const rows = await this.database
      .select({
        rootId: schema.standaloneChatRoots.id,
        chatId: schema.standaloneChatRoots.chatId,
        archivedAt: schema.standaloneChatRoots.archivedAt,
        archiveExpiresAt: schema.standaloneChatRoots.archiveExpiresAt,
      })
      .from(schema.standaloneChatRoots)
      .where(eq(schema.standaloneChatRoots.workerId, workerId));
    return rows.map((row) => ({
      rootId: row.rootId,
      chatId: row.chatId,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      archiveExpiresAt: row.archiveExpiresAt?.toISOString() ?? null,
    }));
  }

  async markMissingRoots(workerId: string, rootIds: string[]): Promise<number> {
    if (rootIds.length === 0) return 0;
    const rows = await this.database
      .update(schema.standaloneChatRoots)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(schema.standaloneChatRoots.workerId, workerId),
          inArray(schema.standaloneChatRoots.id, rootIds),
        ),
      )
      .returning({ id: schema.standaloneChatRoots.id });
    return rows.length;
  }
}
