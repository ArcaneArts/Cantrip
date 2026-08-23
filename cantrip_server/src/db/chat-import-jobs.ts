import { createHash, randomUUID } from "node:crypto";

import {
  chatAttachmentOpaqueSummarySchema,
  chatImportJobListSchema,
  chatImportJobSummarySchema,
  chatMessageOpaqueContentListSchema,
  chatMessageOpaqueSummarySchema,
  chatRelocationContextPayloadSchema,
  externalChatImportReferenceSchema,
  type ChatAttachmentOpaqueSummary,
  type ChatAttachmentSummary,
  type ChatMessageCreate,
  type ChatMessageOpaqueContent,
  type ExternalChatImportReference,
  type ChatImportError,
  type ChatImportJobSummary,
  type ChatImportProgress,
  type ChatRelocationContextPayload,
  type ExternalChatAttachment,
  type ExecutionPlacement,
  type ExternalChatDiscoveryTarget,
  type ExternalChatSourceKind,
  type ExternalChatTranscript,
  type PlanMode,
} from "@cantrip/protocol";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
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
// Imported message rows bind 12 values each. A 500-row batch remains well
// below PostgreSQL's per-statement parameter limit while reducing chatter for
// large histories.
export const CHAT_IMPORT_INSERT_BATCH_SIZE = 500;

export function chatImportInsertBatches<T>(
  values: readonly T[],
  batchSize = CHAT_IMPORT_INSERT_BATCH_SIZE,
): T[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError("Chat import insert batch size must be positive.");
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push(values.slice(offset, offset + batchSize));
  }
  return batches;
}

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

export interface ImportedChatAttachment {
  descriptor: ExternalChatAttachment;
  id: string;
}

export interface ExternalChatImportSourceReference {
  sourceKind: ExternalChatSourceKind;
  sourceWorkerId: string;
  sourceId: string;
  sourceThreadId: string;
  reference: ExternalChatImportReference;
}

export function chatImportAttachmentId(
  jobId: string,
  externalAttachmentId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${jobId}\0${externalAttachmentId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function progress(
  stage: ChatImportProgress["stage"],
  percent: number,
  now = new Date(),
): ChatImportProgress {
  return { stage, percent, updatedAt: toISOString(now) };
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
    error: row.lastErrorCode
      ? {
          code: row.lastErrorCode,
          retryable: row.errorRetryable ?? false,
        }
      : null,
    sourceMetadata: row.sourceMetadata,
    attachmentCount: row.attachmentCount,
    attachmentWarningCount: row.attachmentWarningCount,
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
  constructor(
    private readonly database: ChatImportDatabase,
    private readonly insertBatchSize = CHAT_IMPORT_INSERT_BATCH_SIZE,
  ) {}

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
            progress: progress("queued", 0, now),
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

  async listSourceReferences(
    ownerId: string,
    sourceWorkerIds: string[],
  ): Promise<ExternalChatImportSourceReference[]> {
    const workerIds = [...new Set(sourceWorkerIds)];
    if (workerIds.length === 0) return [];
    const rows = await this.database
      .select({ job: schema.chatImportJobs })
      .from(schema.chatImportJobs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chatImportJobs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chatImportJobs.ownerId, ownerId),
          inArray(schema.chatImportJobs.sourceWorkerId, workerIds),
        ),
      );
    return rows.map(({ job }) => ({
      sourceKind: job.sourceKind,
      sourceWorkerId: job.sourceWorkerId,
      sourceId: job.sourceId,
      sourceThreadId: job.sourceThreadId,
      reference: externalChatImportReferenceSchema.parse({
        jobId: job.id,
        projectId: job.projectId,
        chatId: job.chatId,
        state: job.state,
      }),
    }));
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
        progress: progress("queued", 0, now),
        lastErrorCode: null,
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
        progress: progress("awaiting-hydration", 75, now),
        lastErrorCode: null,
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
              ? progress("reading", 10, now)
              : progress("hydrating", 80, now),
          lastErrorCode: null,
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
        progress: progress("importing", 60, now),
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
    importedAttachments: ImportedChatAttachment[],
    protectMessages: (
      messages: Array<
        ChatMessageCreate & { id: string; idempotencyKey: string }
      >,
      attachments: ChatAttachmentOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
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
      const transcriptAttachmentIds = new Set(
        transcript.attachments.map(({ id }) => id),
      );
      if (
        transcriptAttachmentIds.size !== transcript.attachments.length ||
        importedAttachments.length !== transcript.attachments.length ||
        importedAttachments.some(
          ({ descriptor, id }) =>
            !transcriptAttachmentIds.has(descriptor.id) ||
            id !== descriptor.id ||
            id !==
              chatImportAttachmentId(job.id, descriptor.sourceAttachmentId),
        )
      ) {
        throw new ChatImportJobConflictError(
          "The imported attachment set changed before canonical storage.",
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
      const chatId = job.id;
      const chats = await transaction
        .insert(schema.chats)
        .values({
          id: chatId,
          projectId: job.projectId,
          protectedLabel: transcript.titleProtection,
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
      const attachmentByExternalId = new Map<string, ChatAttachmentSummary>();
      const opaqueAttachments: ChatAttachmentOpaqueSummary[] = [];
      const canonicalAttachments = importedAttachments.map((imported) => {
        const status =
          imported.descriptor.status === "available"
            ? ("ready" as const)
            : ("failed" as const);
        return {
          externalId: imported.descriptor.id,
          row: {
            id: imported.id,
            chatId,
            workerId: job.targetPlacement.workerId,
            protectedMetadata: imported.descriptor.protectedMetadata,
            sizeBytes: imported.descriptor.sizeBytes,
            status,
            createdAt: now,
            updatedAt: now,
          },
        };
      });
      for (const attachments of chatImportInsertBatches(
        canonicalAttachments.map(({ row }) => row),
        this.insertBatchSize,
      )) {
        await transaction.insert(schema.chatAttachments).values(attachments);
      }
      const replicaRows = canonicalAttachments.flatMap(({ row }) =>
        row.status === "ready"
          ? [
              {
                attachmentId: row.id,
                workerId: job.targetPlacement.workerId,
                status: "ready",
                verifiedAt: now,
                createdAt: now,
                updatedAt: now,
              } as const,
            ]
          : [],
      );
      for (const replicas of chatImportInsertBatches(
        replicaRows,
        this.insertBatchSize,
      )) {
        await transaction
          .insert(schema.chatAttachmentReplicas)
          .values(replicas);
      }
      for (const { externalId, row: attachment } of canonicalAttachments) {
        attachmentByExternalId.set(externalId, {
          id: attachment.id,
          chatId,
          fileName: "Protected attachment",
          mimeType: "application/octet-stream",
          sizeBytes: attachment.sizeBytes,
          kind: "file",
          source: "file",
          status: attachment.status,
          previewText: null,
          createdAt: toISOString(attachment.createdAt),
        });
        opaqueAttachments.push(
          chatAttachmentOpaqueSummarySchema.parse({
            id: attachment.id,
            chatId,
            sizeBytes: attachment.sizeBytes,
            status: attachment.status,
            protectedMetadata: attachment.protectedMetadata,
            createdAt: toISOString(attachment.createdAt),
          }),
        );
      }
      const messages = canonicalMessagesFromThreadSync(transcript.sync, {
        idempotencyPrefix: "codex-import",
        interruptedMessage: "Turn interrupted in the imported Codex chat.",
        failedMessage: "The imported Codex turn failed.",
        externalAttachments: attachmentByExternalId,
      });
      const protectedMessages = chatMessageOpaqueContentListSchema.parse(
        await protectMessages(
          messages.map(({ message }) => ({
            ...message,
            id: randomUUID(),
            idempotencyKey: message.idempotencyKey!,
          })),
          opaqueAttachments,
        ),
      );
      if (
        protectedMessages.length !== messages.length ||
        protectedMessages.some(
          (message, index) =>
            message.idempotencyKey !== messages[index]?.message.idempotencyKey,
        )
      ) {
        throw new ChatImportJobConflictError(
          "The destination worker returned an inconsistent encrypted transcript.",
        );
      }
      const messageRows = protectedMessages.map((message) => ({
        id: message.id,
        chatId,
        worktreeId: worktree.id,
        executionLaneId,
        role: message.classification.role,
        mode: message.classification.mode,
        content: null,
        protectedContent: message.protectedContent,
        attachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
        createdAt: now,
      }));
      for (const messages of chatImportInsertBatches(
        messageRows,
        this.insertBatchSize,
      )) {
        await transaction.insert(schema.chatMessages).values(messages);
      }
      const rows = await transaction
        .update(schema.chatImportJobs)
        .set({
          chatId,
          state: "awaiting-hydration",
          stateRevision: job.stateRevision + 1,
          commandId: null,
          leaseExpiresAt: null,
          sourceMetadata: null,
          attachmentCount: importedAttachments.length,
          attachmentWarningCount: importedAttachments.filter(
            ({ descriptor }) => descriptor.status !== "available",
          ).length,
          progress: progress("awaiting-hydration", 75, now),
          lastErrorCode: null,
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
    const referencedAttachmentIds = [
      ...new Set(
        messages.flatMap((message) => {
          if (
            !message.protectedContent ||
            message.content ||
            message.taskProtectedContent
          ) {
            throw new ChatImportJobConflictError(
              "The imported transcript contains an invalid encrypted message.",
            );
          }
          return message.attachmentIds;
        }),
      ),
    ];
    const attachmentRows = referencedAttachmentIds.length
      ? await this.database
          .select({
            attachment: schema.chatAttachments,
            replica: schema.chatAttachmentReplicas,
          })
          .from(schema.chatAttachments)
          .leftJoin(
            schema.chatAttachmentReplicas,
            eq(
              schema.chatAttachmentReplicas.attachmentId,
              schema.chatAttachments.id,
            ),
          )
          .where(
            and(
              eq(schema.chatAttachments.chatId, chatId),
              inArray(schema.chatAttachments.id, referencedAttachmentIds),
            ),
          )
      : [];
    const attachmentsById = new Map(
      referencedAttachmentIds.map((attachmentId) => [
        attachmentId,
        attachmentRows.filter(
          ({ attachment }) => attachment.id === attachmentId,
        ),
      ]),
    );
    if (
      [...attachmentsById.values()].some((availability) => {
        const attachment = availability[0]?.attachment;
        return (
          !attachment ||
          (attachment.status === "ready" &&
            !availability.some(({ replica }) => replica?.status === "ready"))
        );
      })
    ) {
      throw new ChatImportJobConflictError(
        "An imported attachment is missing from canonical chat state.",
      );
    }
    return {
      payload: chatRelocationContextPayloadSchema.parse({
        version: 1,
        kind: "chat-encrypted",
        messages: messages.map((message) =>
          chatMessageOpaqueSummarySchema.parse({
            id: message.id,
            chatId: message.chatId,
            worktreeId: message.worktreeId,
            executionLaneId: message.executionLaneId,
            sequence: message.sequence,
            role: message.role,
            mode: message.mode,
            attachmentIds: message.attachmentIds,
            protectedContent: message.protectedContent,
            modelId: message.modelId,
            modelRouteId: message.modelRouteId,
            providerId: message.providerId,
            providerName: message.providerName,
            providerModelName: message.providerModelName,
            reasoningEffort: message.reasoningEffort,
            appliedReasoningEffort: message.appliedReasoningEffort,
            reasoningAdjusted: message.reasoningAdjusted,
            idempotencyKey: message.idempotencyKey,
            createdAt: toISOString(message.createdAt),
          }),
        ),
        attachments: referencedAttachmentIds.map((attachmentId) => {
          const availability = attachmentsById.get(attachmentId)!;
          const attachment = availability[0]!.attachment;
          return {
            attachment: {
              id: attachment.id,
              chatId: attachment.chatId,
              sizeBytes: attachment.sizeBytes,
              status: attachment.status,
              protectedMetadata: attachment.protectedMetadata,
              createdAt: toISOString(attachment.createdAt),
            },
            sourceWorkerId: attachment.workerId,
            availableWorkerIds: [
              ...new Set(
                availability.flatMap(({ replica }) =>
                  replica?.status === "ready" ? [replica.workerId] : [],
                ),
              ),
            ].sort(),
          };
        }),
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
          progress: progress("succeeded", 100, now),
          lastErrorCode: null,
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

  async completeWithoutHydration(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<ChatImportJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "succeeded",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        progress: progress("succeeded", 100, now),
        lastErrorCode: null,
        errorRetryable: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatImportJobs.id, jobId),
          eq(schema.chatImportJobs.commandId, commandId),
          eq(schema.chatImportJobs.attempt, attempt),
          eq(schema.chatImportJobs.state, "hydrating"),
          isNotNull(schema.chatImportJobs.chatId),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new ChatImportJobStaleAttemptError("Import attempt is stale.");
    }
    return toJob(rows[0]);
  }

  async completeUnsupportedHydrationImports(): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatImportJobs)
      .set({
        state: "succeeded",
        stateRevision: sql`${schema.chatImportJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        progress: progress("succeeded", 100, now),
        lastErrorCode: null,
        errorRetryable: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(schema.chatImportJobs.state, ["blocked", "failed"]),
          inArray(schema.chatImportJobs.lastErrorCode, [
            "capability-missing",
            "runtime-incompatible",
          ]),
          isNotNull(schema.chatImportJobs.chatId),
          isNull(schema.chatImportJobs.managedThreadId),
        ),
      )
      .returning({ id: schema.chatImportJobs.id });
    return rows.length;
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
        progress: progress(state, state === "failed" ? 100 : 0, now),
        lastErrorCode: error.code,
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
              ? progress("queued", 0, now)
              : progress("awaiting-hydration", 75, now),
          lastErrorCode: null,
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
        progress: progress("queued", 0, now),
        lastErrorCode: null,
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
        progress: progress("awaiting-hydration", 75, now),
        lastErrorCode: null,
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
