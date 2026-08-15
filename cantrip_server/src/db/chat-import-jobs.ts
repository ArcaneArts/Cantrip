import { createHash, randomUUID } from "node:crypto";

import {
  chatImportJobListSchema,
  chatImportJobSummarySchema,
  type ChatImportError,
  type ChatImportJobSummary,
  type ChatImportProgress,
  type ExecutionPlacement,
  type ExternalChatDiscoveryTarget,
  type ExternalChatSourceKind,
  type ExternalChatTranscript,
  type PlanMode,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import { attachProjectTab } from "./tab-layouts.js";
import { canonicalMessagesFromThreadSync } from "../chats/thread-sync.js";

type ChatImportDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ChatImportJobRow = typeof schema.chatImportJobs.$inferSelect;

const RUNNING_STATES = ["reading", "importing", "hydrating"] as const;
export const CHAT_IMPORT_JOB_LEASE_MS = 2 * 60_000;
export const CHAT_IMPORT_JOB_HISTORY_LIMIT = 1_000;

export class ChatImportJobConflictError extends Error {}
export class ChatImportJobNotFoundError extends Error {}
export class ChatImportJobStaleAttemptError extends Error {}

export interface CreateChatImportJobInput {
  sourceKind: ExternalChatSourceKind;
  sourceWorkerId: string;
  sourceId: string;
  sourceThreadId: string;
  targetPlacement: ExecutionPlacement;
  modelId: string | null;
  permissionProfileId: string | null;
  planMode: PlanMode;
  idempotencyKey: string;
}

export interface ClaimedChatImportJob {
  commandId: string;
  job: ChatImportJobSummary;
  ownerId: string;
}

export interface ChatImportReadContext {
  targets: ExternalChatDiscoveryTarget[];
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function progress(
  stage: string,
  percent: number,
  message: string,
  now = new Date(),
): ChatImportProgress {
  return { stage, percent, message, updatedAt: toISOString(now) };
}

function toJob(row: ChatImportJobRow): ChatImportJobSummary {
  return chatImportJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    chatId: row.chatId,
    sourceKind: row.sourceKind,
    sourceWorkerId: row.sourceWorkerId,
    sourceId: row.sourceId,
    sourceThreadId: row.sourceThreadId,
    targetPlacement: row.targetPlacement,
    state: row.state,
    stateRevision: row.stateRevision,
    idempotencyKey: row.idempotencyKey,
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
    sourceMetadata: row.sourceMetadata,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
    startedAt: row.startedAt ? toISOString(row.startedAt) : null,
    completedAt: row.completedAt ? toISOString(row.completedAt) : null,
  });
}

function payloadFingerprint(
  projectId: string,
  input: CreateChatImportJobInput,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        sourceKind: input.sourceKind,
        sourceWorkerId: input.sourceWorkerId,
        sourceId: input.sourceId,
        sourceThreadId: input.sourceThreadId,
        targetPlacement: input.targetPlacement,
        modelId: input.modelId,
        permissionProfileId: input.permissionProfileId,
        planMode: input.planMode,
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

export class ChatImportJobRepository {
  constructor(private readonly database: ChatImportDatabase) {}

  async create(
    ownerId: string,
    projectId: string,
    input: CreateChatImportJobInput,
  ): Promise<ChatImportJobSummary> {
    const fingerprint = payloadFingerprint(projectId, input);
    const existing = await this.database
      .select()
      .from(schema.chatImportJobs)
      .where(
        and(
          eq(schema.chatImportJobs.ownerId, ownerId),
          eq(schema.chatImportJobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadFingerprint !== fingerprint) {
        throw new ChatImportJobConflictError(
          "This idempotency key belongs to a different import request.",
        );
      }
      return toJob(existing[0]);
    }

    const now = new Date();
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [projectRows, sourceRows, targetRows, modelRows] =
          await Promise.all([
            transaction
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(
                and(
                  eq(schema.projects.id, projectId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .limit(1),
            transaction
              .select({ id: schema.projectSources.id })
              .from(schema.projectSources)
              .innerJoin(
                schema.workers,
                and(
                  eq(schema.workers.id, schema.projectSources.workerId),
                  eq(schema.workers.ownerId, ownerId),
                  isNull(schema.workers.unlinkedAt),
                ),
              )
              .where(
                and(
                  eq(schema.projectSources.projectId, projectId),
                  eq(schema.projectSources.workerId, input.sourceWorkerId),
                  isNull(schema.projectSources.removedAt),
                ),
              )
              .limit(1),
            input.targetPlacement.worktreeId
              ? transaction
                  .select({ id: schema.projectWorktrees.id })
                  .from(schema.projectWorktrees)
                  .innerJoin(
                    schema.projectSources,
                    and(
                      eq(
                        schema.projectSources.id,
                        schema.projectWorktrees.projectSourceId,
                      ),
                      eq(schema.projectSources.projectId, projectId),
                      eq(
                        schema.projectSources.workerId,
                        input.targetPlacement.workerId,
                      ),
                      isNull(schema.projectSources.removedAt),
                    ),
                  )
                  .where(
                    and(
                      eq(
                        schema.projectWorktrees.id,
                        input.targetPlacement.worktreeId,
                      ),
                      eq(schema.projectWorktrees.lifecycleState, "ready"),
                    ),
                  )
                  .limit(1)
              : Promise.resolve([]),
            input.modelId
              ? transaction
                  .select({ id: schema.modelProfiles.id })
                  .from(schema.modelProfiles)
                  .where(
                    and(
                      eq(schema.modelProfiles.id, input.modelId),
                      eq(schema.modelProfiles.ownerId, ownerId),
                    ),
                  )
                  .limit(1)
              : Promise.resolve([{ id: null }]),
          ]);
        if (!projectRows[0]) {
          throw new ChatImportJobNotFoundError("Project not found.");
        }
        if (!sourceRows[0]) {
          throw new ChatImportJobConflictError(
            "The source worker does not have a replica of this project.",
          );
        }
        if (
          input.targetPlacement.projectId !== projectId ||
          input.targetPlacement.projectReplicaId === null ||
          input.targetPlacement.worktreeId === null ||
          input.targetPlacement.surface !== null ||
          !targetRows[0]
        ) {
          throw new ChatImportJobConflictError(
            "The selected destination is not a ready project worktree.",
          );
        }
        if (!modelRows[0]) {
          throw new ChatImportJobConflictError(
            "The selected model profile was not found.",
          );
        }
        const rows = await transaction
          .insert(schema.chatImportJobs)
          .values({
            id: randomUUID(),
            ownerId,
            projectId,
            sourceKind: input.sourceKind,
            sourceWorkerId: input.sourceWorkerId,
            sourceId: input.sourceId,
            sourceThreadId: input.sourceThreadId,
            targetPlacement: input.targetPlacement,
            requestedModelId: input.modelId,
            requestedPermissionProfileId: input.permissionProfileId,
            requestedPlanMode: input.planMode,
            state: "queued",
            idempotencyKey: input.idempotencyKey,
            payloadFingerprint: fingerprint,
            progress: progress(
              "queued",
              0,
              "Waiting to read the source chat.",
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
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.ownerId, ownerId),
            or(
              eq(schema.chatImportJobs.idempotencyKey, input.idempotencyKey),
              and(
                eq(schema.chatImportJobs.sourceKind, input.sourceKind),
                eq(schema.chatImportJobs.sourceWorkerId, input.sourceWorkerId),
                eq(schema.chatImportJobs.sourceId, input.sourceId),
                eq(schema.chatImportJobs.sourceThreadId, input.sourceThreadId),
              ),
            ),
          ),
        )
        .limit(1);
      if (raced[0]?.payloadFingerprint === fingerprint) return toJob(raced[0]);
      throw new ChatImportJobConflictError(
        "This Codex chat already has a different import request.",
      );
    }
  }

  async get(
    ownerId: string,
    jobId: string,
  ): Promise<ChatImportJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.chatImportJobs)
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async list(
    ownerId: string,
    projectId: string,
  ): Promise<ChatImportJobSummary[] | null> {
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
      .from(schema.chatImportJobs)
      .where(eq(schema.chatImportJobs.projectId, projectId))
      .orderBy(
        desc(schema.chatImportJobs.createdAt),
        desc(schema.chatImportJobs.id),
      )
      .limit(CHAT_IMPORT_JOB_HISTORY_LIMIT);
    return chatImportJobListSchema.parse(rows.reverse().map(toJob));
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
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
      .where(
        force
          ? inArray(schema.chatImportJobs.state, [...RUNNING_STATES])
          : and(
              inArray(schema.chatImportJobs.state, [...RUNNING_STATES]),
              or(
                isNull(schema.chatImportJobs.leaseExpiresAt),
                lte(schema.chatImportJobs.leaseExpiresAt, now),
              ),
            ),
      )
      .returning({ id: schema.chatImportJobs.id });
    return rows.length;
  }

  async claimNext(): Promise<ClaimedChatImportJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.state, "queued"),
            lte(schema.chatImportJobs.availableAt, now),
          ),
        )
        .orderBy(
          asc(schema.chatImportJobs.availableAt),
          asc(schema.chatImportJobs.createdAt),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return null;
      const commandId = randomUUID();
      const rows = await transaction
        .update(schema.chatImportJobs)
        .set({
          state: "reading",
          stateRevision: candidate.stateRevision + 1,
          attempt: candidate.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(now.getTime() + CHAT_IMPORT_JOB_LEASE_MS),
          startedAt: candidate.startedAt ?? now,
          progress: progress(
            "reading",
            10,
            "Reading source chat history.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatImportJobs.id, candidate.id),
            eq(schema.chatImportJobs.state, "queued"),
            eq(schema.chatImportJobs.stateRevision, candidate.stateRevision),
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
      .update(schema.chatImportJobs)
      .set({
        leaseExpiresAt: new Date(now.getTime() + CHAT_IMPORT_JOB_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          inArray(schema.chatImportJobs.state, [...RUNNING_STATES]),
          eq(schema.chatImportJobs.commandId, commandId),
          eq(schema.chatImportJobs.attempt, attempt),
        ),
      )
      .returning({ id: schema.chatImportJobs.id });
    return rows.length === 1;
  }

  async readContext(
    jobId: string,
    commandId: string,
  ): Promise<ChatImportReadContext | null> {
    const jobs = await this.database
      .select({
        projectId: schema.chatImportJobs.projectId,
        sourceWorkerId: schema.chatImportJobs.sourceWorkerId,
      })
      .from(schema.chatImportJobs)
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.commandId, commandId),
          eq(schema.chatImportJobs.state, "reading"),
        ),
      )
      .limit(1);
    const job = jobs[0];
    if (!job) return null;
    const rows = await this.database
      .select({
        source: schema.projectSources,
        worktree: schema.projectWorktrees,
      })
      .from(schema.projectSources)
      .leftJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
      )
      .where(
        and(
          eq(schema.projectSources.projectId, job.projectId),
          eq(schema.projectSources.workerId, job.sourceWorkerId),
          isNull(schema.projectSources.removedAt),
        ),
      );
    const sources = new Map<string, ExternalChatDiscoveryTarget>();
    for (const { source, worktree } of rows) {
      let target = sources.get(source.id);
      if (!target) {
        target = {
          projectReplicaId: source.id,
          path: source.absolutePath,
          repositoryFingerprint: source.repositoryFingerprint,
          worktrees: [],
        };
        sources.set(source.id, target);
      }
      if (worktree) {
        target.worktrees.push({
          worktreeId: worktree.id,
          path: worktree.absolutePath,
          isPrimary: worktree.isPrimary,
        });
      }
    }
    return sources.size > 0 ? { targets: [...sources.values()] } : null;
  }

  async markImporting(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<ChatImportJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "importing",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        progress: progress(
          "importing",
          60,
          "Saving the canonical transcript.",
          now,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.commandId, commandId),
          eq(schema.chatImportJobs.attempt, attempt),
          eq(schema.chatImportJobs.state, "reading"),
        ),
      )
      .returning();
    if (!rows[0])
      throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
    return toJob(rows[0]);
  }

  async completeCanonicalImport(
    jobId: string,
    commandId: string,
    attempt: number,
    transcript: ExternalChatTranscript,
  ): Promise<ChatImportJobSummary> {
    const now = new Date();
    const completed = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(schema.chatImportJobs)
        .where(eq(schema.chatImportJobs.id, jobId))
        .for("update")
        .limit(1);
      const job = jobs[0];
      if (
        !job ||
        job.commandId !== commandId ||
        job.attempt !== attempt ||
        job.state !== "importing"
      ) {
        throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
      }
      if (
        transcript.sourceId !== job.sourceId ||
        transcript.sourceThreadId !== job.sourceThreadId ||
        transcript.sync.threadId !== job.sourceThreadId
      ) {
        throw new ChatImportJobConflictError(
          "The source chat identity changed while it was being imported.",
        );
      }
      const sourceMatches = await transaction
        .select({ id: schema.projectSources.id })
        .from(schema.projectSources)
        .where(
          and(
            eq(
              schema.projectSources.id,
              transcript.metadata.match.projectReplicaId,
            ),
            eq(schema.projectSources.projectId, job.projectId),
            eq(schema.projectSources.workerId, job.sourceWorkerId),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      const targetWorktrees = job.targetPlacement.worktreeId
        ? await transaction
            .select({ worktree: schema.projectWorktrees })
            .from(schema.projectWorktrees)
            .innerJoin(
              schema.projectSources,
              and(
                eq(
                  schema.projectSources.id,
                  schema.projectWorktrees.projectSourceId,
                ),
                eq(schema.projectSources.projectId, job.projectId),
                eq(
                  schema.projectSources.workerId,
                  job.targetPlacement.workerId,
                ),
                isNull(schema.projectSources.removedAt),
              ),
            )
            .where(
              and(
                eq(schema.projectWorktrees.id, job.targetPlacement.worktreeId),
                eq(schema.projectWorktrees.lifecycleState, "ready"),
              ),
            )
            .limit(1)
        : [];
      const worktree = targetWorktrees[0]?.worktree;
      if (!sourceMatches[0] || !worktree) {
        throw new ChatImportJobConflictError(
          "The source project match or destination worktree is no longer valid.",
        );
      }
      const positions = await transaction
        .select({ position: schema.chats.position })
        .from(schema.chats)
        .where(eq(schema.chats.projectId, job.projectId))
        .orderBy(desc(schema.chats.position))
        .limit(1);
      const chatId = randomUUID();
      const chats = await transaction
        .insert(schema.chats)
        .values({
          id: chatId,
          projectId: job.projectId,
          title: transcript.metadata.title.slice(0, 200),
          position: (positions[0]?.position ?? -1) + 1,
          status: "idle",
          activeWorkerId: job.targetPlacement.workerId,
          activeWorktreeId: worktree.id,
          worktreeMode: worktree.isPrimary ? "agent-managed" : "pinned",
          modelId: job.requestedModelId,
          permissionProfileId: job.requestedPermissionProfileId,
          planMode: job.requestedPlanMode,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const runtimeSessionId = randomUUID();
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId,
        workerId: job.targetPlacement.workerId,
        worktreeId: worktree.id,
        status: "detached",
      });
      const executionLaneId = randomUUID();
      await transaction.insert(schema.chatExecutionLanes).values({
        id: executionLaneId,
        chatId,
        worktreeId: worktree.id,
        workerId: job.targetPlacement.workerId,
        acquiringActor: "import",
        exclusive: !worktree.isPrimary,
        purpose: "Imported Codex chat",
        state: "suspended",
        startingHead: worktree.head,
        runtimeSessionId,
      });
      await attachProjectTab(transaction, {
        projectId: job.projectId,
        tabId: chatId,
        tabKind: "chat",
      });
      const messages = canonicalMessagesFromThreadSync(transcript.sync, {
        idempotencyPrefix: "codex-import",
        interruptedMessage: "Turn interrupted in the imported Codex chat.",
        failedMessage: "The imported Codex turn failed.",
      });
      for (const { message } of messages) {
        await transaction.insert(schema.chatMessages).values({
          id: randomUUID(),
          chatId,
          worktreeId: worktree.id,
          executionLaneId,
          role: message.role,
          mode: "default",
          content: message.content,
          idempotencyKey: message.idempotencyKey,
          createdAt: now,
        });
      }
      const rows = await transaction
        .update(schema.chatImportJobs)
        .set({
          chatId,
          state: "awaiting-hydration",
          stateRevision: job.stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          sourceMetadata: transcript.metadata,
          progress: progress(
            "awaiting-hydration",
            75,
            "Chat history is saved and waiting for runtime hydration.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatImportJobs.id, jobId),
            eq(schema.chatImportJobs.commandId, commandId),
            eq(schema.chatImportJobs.state, "importing"),
          ),
        )
        .returning();
      if (!rows[0] || !chats[0]) {
        throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
      }
      return rows[0];
    });
    return toJob(completed);
  }

  async block(
    jobId: string,
    commandId: string,
    error: ChatImportError,
  ): Promise<ChatImportJobSummary> {
    return this.settle(jobId, commandId, "blocked", error);
  }

  async fail(
    jobId: string,
    commandId: string,
    error: ChatImportError,
  ): Promise<ChatImportJobSummary> {
    return this.settle(jobId, commandId, "failed", error);
  }

  private async settle(
    jobId: string,
    commandId: string,
    state: "blocked" | "failed",
    error: ChatImportError,
  ): Promise<ChatImportJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state,
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        progress: progress(
          state,
          state === "failed" ? 100 : 0,
          error.message,
          now,
        ),
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        errorRetryable: error.retryable,
        completedAt: state === "failed" ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.commandId, commandId),
          inArray(schema.chatImportJobs.state, [...RUNNING_STATES]),
        ),
      )
      .returning();
    if (!rows[0])
      throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
    return toJob(rows[0]);
  }

  async retry(
    ownerId: string,
    jobId: string,
    stateRevision: number,
  ): Promise<ChatImportJobSummary | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
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
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.ownerId, ownerId),
          eq(schema.chatImportJobs.stateRevision, stateRevision),
          inArray(schema.chatImportJobs.state, ["blocked", "failed"]),
          isNull(schema.chatImportJobs.chatId),
        ),
      )
      .returning();
    return rows[0] ? toJob(rows[0]) : null;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        availableAt: now,
        progress: progress(
          "queued",
          0,
          "Source worker reconnected; retrying.",
          now,
        ),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatImportJobs.sourceWorkerId, workerId),
          eq(schema.chatImportJobs.state, "blocked"),
          eq(schema.chatImportJobs.errorRetryable, true),
          isNull(schema.chatImportJobs.chatId),
        ),
      )
      .returning({ id: schema.chatImportJobs.id });
    return rows.length;
  }
}
