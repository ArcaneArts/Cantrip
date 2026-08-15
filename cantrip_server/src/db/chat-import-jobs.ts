import { createHash, randomUUID } from "node:crypto";

import {
  chatImportJobListSchema,
  chatImportJobSummarySchema,
  chatRelocationContextPayloadSchema,
  type ChatImportError,
  type ChatImportJobSummary,
  type ChatImportProgress,
  type ChatRelocationContextPayload,
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
  modelRouteId: string | null;
  providerAccountId: string | null;
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

export interface ChatImportHydrationContext {
  payload: ChatRelocationContextPayload;
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
    managedThreadId: row.managedThreadId,
    targetModelRouteId: row.targetModelRouteId,
    targetProviderAccountId: row.targetProviderAccountId,
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
        modelRouteId: input.modelRouteId,
        providerAccountId: input.providerAccountId,
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
        const [
          projectRows,
          sourceRows,
          targetRows,
          modelRows,
          routeRows,
          accountRows,
        ] = await Promise.all([
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
          input.modelRouteId
            ? transaction
                .select({
                  id: schema.modelRoutes.id,
                  modelId: schema.modelRoutes.modelId,
                  providerId: schema.modelRoutes.providerId,
                })
                .from(schema.modelRoutes)
                .innerJoin(
                  schema.modelProfiles,
                  and(
                    eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
                    eq(schema.modelProfiles.ownerId, ownerId),
                  ),
                )
                .where(eq(schema.modelRoutes.id, input.modelRouteId))
                .limit(1)
            : Promise.resolve([]),
          input.providerAccountId
            ? transaction
                .select({
                  id: schema.modelProviderAccounts.id,
                  providerId: schema.modelProviderAccounts.providerId,
                })
                .from(schema.modelProviderAccounts)
                .innerJoin(
                  schema.modelProviders,
                  and(
                    eq(
                      schema.modelProviders.id,
                      schema.modelProviderAccounts.providerId,
                    ),
                    eq(schema.modelProviders.ownerId, ownerId),
                  ),
                )
                .where(
                  eq(schema.modelProviderAccounts.id, input.providerAccountId),
                )
                .limit(1)
            : Promise.resolve([]),
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
        if (
          input.modelRouteId &&
          (!input.modelId || routeRows[0]?.modelId !== input.modelId)
        ) {
          throw new ChatImportJobConflictError(
            "The selected model route does not belong to the selected model profile.",
          );
        }
        if (
          input.providerAccountId &&
          (!routeRows[0] ||
            accountRows[0]?.providerId !== routeRows[0].providerId)
        ) {
          throw new ChatImportJobConflictError(
            "The selected provider account does not belong to the selected model route.",
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
            targetModelRouteId: input.modelRouteId,
            targetProviderAccountId: input.providerAccountId,
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
    const interrupted = force
      ? inArray(schema.chatImportJobs.state, [...RUNNING_STATES])
      : and(
          inArray(schema.chatImportJobs.state, [...RUNNING_STATES]),
          or(
            isNull(schema.chatImportJobs.leaseExpiresAt),
            lte(schema.chatImportJobs.leaseExpiresAt, now),
          ),
        );
    const preCanonical = await this.database
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
      .where(and(interrupted, isNull(schema.chatImportJobs.chatId)))
      .returning({ id: schema.chatImportJobs.id });
    const postCanonical = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "awaiting-hydration",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        progress: progress(
          "awaiting-hydration",
          75,
          "Recovered runtime hydration after the server restarted.",
          now,
        ),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(and(interrupted, sql`${schema.chatImportJobs.chatId} IS NOT NULL`))
      .returning({ id: schema.chatImportJobs.id });
    return preCanonical.length + postCanonical.length;
  }

  async claimNext(): Promise<ClaimedChatImportJob | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(schema.chatImportJobs)
        .where(
          and(
            inArray(schema.chatImportJobs.state, [
              "queued",
              "awaiting-hydration",
            ]),
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
      const nextState = candidate.chatId ? "hydrating" : "reading";
      const rows = await transaction
        .update(schema.chatImportJobs)
        .set({
          state: nextState,
          stateRevision: candidate.stateRevision + 1,
          attempt: candidate.attempt + 1,
          commandId,
          leaseExpiresAt: new Date(now.getTime() + CHAT_IMPORT_JOB_LEASE_MS),
          startedAt: candidate.startedAt ?? now,
          progress:
            nextState === "reading"
              ? progress("reading", 10, "Reading source chat history.", now)
              : progress(
                  "hydrating",
                  80,
                  "Creating a managed Codex thread.",
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
            eq(schema.chatImportJobs.state, candidate.state),
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

  async hydrationContext(
    jobId: string,
    commandId: string,
  ): Promise<ChatImportHydrationContext | null> {
    const jobs = await this.database
      .select({ chatId: schema.chatImportJobs.chatId })
      .from(schema.chatImportJobs)
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.commandId, commandId),
          eq(schema.chatImportJobs.state, "hydrating"),
        ),
      )
      .limit(1);
    const chatId = jobs[0]?.chatId;
    if (!chatId) return null;
    const messages = await this.database
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    if (messages.length > 100_000) {
      throw new ChatImportJobConflictError(
        "The imported transcript is too large to hydrate safely.",
      );
    }
    if (
      messages.some((message) =>
        message.content.some((item) => item.type === "attachment"),
      )
    ) {
      throw new ChatImportJobConflictError(
        "Imported attachments must be staged before runtime hydration.",
      );
    }
    return {
      payload: chatRelocationContextPayloadSchema.parse({
        version: 1,
        messages: messages.map((message) => ({
          sequence: message.sequence,
          role: message.role,
          mode: message.mode,
          reasoningEffort: message.reasoningEffort,
          content: message.content,
          createdAt: toISOString(message.createdAt),
        })),
        attachments: [],
      }),
    };
  }

  async completeHydration(
    jobId: string,
    commandId: string,
    attempt: number,
    input: {
      modelId: string;
      modelRouteId: string;
      providerAccountId: string | null;
      threadId: string;
    },
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
        !job.chatId ||
        job.commandId !== commandId ||
        job.attempt !== attempt ||
        job.state !== "hydrating"
      ) {
        throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
      }
      if (input.threadId === job.sourceThreadId) {
        throw new ChatImportJobConflictError(
          "The external source thread cannot be adopted as a Cantrip-managed runtime.",
        );
      }
      const sessions = await transaction
        .select()
        .from(schema.chatRuntimeSessions)
        .where(
          and(
            eq(schema.chatRuntimeSessions.chatId, job.chatId),
            eq(
              schema.chatRuntimeSessions.workerId,
              job.targetPlacement.workerId,
            ),
            job.targetPlacement.worktreeId
              ? eq(
                  schema.chatRuntimeSessions.worktreeId,
                  job.targetPlacement.worktreeId,
                )
              : sql`false`,
          ),
        )
        .limit(1);
      const session = sessions[0];
      if (!session) {
        throw new ChatImportJobConflictError(
          "The imported chat runtime session no longer exists.",
        );
      }
      await transaction
        .update(schema.chatRuntimeSessions)
        .set({
          codexThreadId: input.threadId,
          modelRouteId: input.modelRouteId,
          providerAccountId: input.providerAccountId,
          status: "attached",
          updatedAt: now,
        })
        .where(eq(schema.chatRuntimeSessions.id, session.id));
      await transaction
        .update(schema.chatExecutionLanes)
        .set({
          codexThreadId: input.threadId,
          runtimeSessionId: session.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatExecutionLanes.chatId, job.chatId),
            eq(schema.chatExecutionLanes.runtimeSessionId, session.id),
            eq(schema.chatExecutionLanes.state, "suspended"),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({
          modelId: input.modelId,
          status: "idle",
          updatedAt: now,
        })
        .where(eq(schema.chats.id, job.chatId));
      const rows = await transaction
        .update(schema.chatImportJobs)
        .set({
          state: "succeeded",
          stateRevision: job.stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          managedThreadId: input.threadId,
          targetModelRouteId: input.modelRouteId,
          targetProviderAccountId: input.providerAccountId,
          progress: progress(
            "succeeded",
            100,
            "Chat history is imported and ready to continue.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatImportJobs.id, jobId),
            eq(schema.chatImportJobs.commandId, commandId),
            eq(schema.chatImportJobs.state, "hydrating"),
          ),
        )
        .returning();
      if (!rows[0]) {
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
    const rows = await this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select()
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.id, jobId),
            eq(schema.chatImportJobs.ownerId, ownerId),
            eq(schema.chatImportJobs.stateRevision, stateRevision),
            inArray(schema.chatImportJobs.state, ["blocked", "failed"]),
          ),
        )
        .for("update")
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return [];
      const nextState = candidate.chatId ? "awaiting-hydration" : "queued";
      return transaction
        .update(schema.chatImportJobs)
        .set({
          state: nextState,
          stateRevision: stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          availableAt: now,
          completedAt: null,
          progress:
            nextState === "queued"
              ? progress("queued", 0, "Retry requested.", now)
              : progress(
                  "awaiting-hydration",
                  75,
                  "Runtime hydration retry requested.",
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
            eq(schema.chatImportJobs.stateRevision, stateRevision),
          ),
        )
        .returning();
    });
    return rows[0] ? toJob(rows[0]) : null;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const preCanonical = await this.database
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
    const postCanonical = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "awaiting-hydration",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        availableAt: now,
        progress: progress(
          "awaiting-hydration",
          75,
          "Destination worker reconnected; retrying hydration.",
          now,
        ),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          sql`${schema.chatImportJobs.targetPlacement}->>'workerId' = ${workerId}`,
          eq(schema.chatImportJobs.state, "blocked"),
          eq(schema.chatImportJobs.errorRetryable, true),
          sql`${schema.chatImportJobs.chatId} IS NOT NULL`,
        ),
      )
      .returning({ id: schema.chatImportJobs.id });
    return preCanonical.length + postCanonical.length;
  }
}
