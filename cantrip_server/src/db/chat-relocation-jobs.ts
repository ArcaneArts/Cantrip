import { createHash, randomUUID } from "node:crypto";

import {
  chatRelocationContextPayloadSchema,
  chatRelocationJobListSchema,
  chatRelocationJobSummarySchema,
  chatRelocationSnapshotSummarySchema,
  chatWireSummarySchema,
  type ChatRelocationContextPayload,
  type ChatRelocationError,
  type ChatRelocationJobSummary,
  type ChatRelocationProgress,
  type ChatRelocationSnapshotSummary,
  type ChatWireSummary,
  type ExecutionPlacement,
} from "@cantrip/protocol";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";
import { encodeCanonicalChatPayload } from "../chats/hydration.js";
import {
  acquireChatLogicalBranchLease,
  LogicalBranchLeaseConflictError,
  releaseChatLogicalBranchLease,
} from "./logical-branch-leases.js";

type ChatRelocationDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ChatRelocationJobRow = typeof schema.chatRelocationJobs.$inferSelect;
type ChatRelocationSnapshotRow =
  typeof schema.chatRelocationSnapshots.$inferSelect;

const ACTIVE_STATES = [
  "queued",
  "waiting-for-idle",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "blocked",
] as const;
const RUNNING_STATES = [
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
] as const;
export const CHAT_RELOCATION_JOB_LEASE_MS = 2 * 60_000;
export const CHAT_RELOCATION_JOB_HISTORY_LIMIT = 1_000;

export class ChatRelocationJobConflictError extends Error {}
export class ChatRelocationJobNotFoundError extends Error {}
export class ChatRelocationJobStaleAttemptError extends Error {}

export interface ChatRelocationSnapshotRecord {
  payload: ChatRelocationContextPayload;
  summary: ChatRelocationSnapshotSummary;
}

export interface ClaimedChatRelocationJob {
  commandId: string;
  job: ChatRelocationJobSummary;
  ownerId: string;
  snapshot: ChatRelocationSnapshotRecord;
}

function toISOString(value: Date): string {
  return value.toISOString();
}

async function relocationAttachmentIds(
  database: ChatRelocationDatabase,
  chatId: string,
  messages: readonly (typeof schema.chatMessages.$inferSelect)[],
): Promise<string[]> {
  const taskRows = await database
    .select({ draftAttachmentIds: schema.tasks.draftAttachmentIds })
    .from(schema.tasks)
    .where(eq(schema.tasks.chatId, chatId))
    .limit(1);
  return [
    ...new Set([
      ...messages.flatMap((message) =>
        message.taskProtectedContent
          ? message.taskAttachmentIds
          : message.protectedContent
            ? message.attachmentIds
            : attachmentIds(message.content),
      ),
      ...(taskRows[0]?.draftAttachmentIds ?? []),
    ]),
  ];
}

function relocationMessages(
  experience: string,
  messages: readonly (typeof schema.chatMessages.$inferSelect)[],
) {
  if (experience === "task") {
    return messages.map((message) => {
      if (!message.taskProtectedContent || message.content) {
        throw new ChatRelocationJobConflictError(
          "The encrypted Task transcript contains an invalid message.",
        );
      }
      return {
        id: message.id,
        chatId: message.chatId,
        worktreeId: message.worktreeId,
        executionLaneId: message.executionLaneId,
        sequence: message.sequence,
        role: message.role,
        mode: message.mode,
        attachmentIds: message.taskAttachmentIds,
        protectedContent: message.taskProtectedContent,
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
      };
    });
  }
  if (experience !== "agent") {
    throw new ChatRelocationJobConflictError(
      "The chat experience cannot be relocated.",
    );
  }
  return messages.map((message) => {
    if (
      !message.protectedContent ||
      message.content ||
      message.taskProtectedContent
    ) {
      throw new ChatRelocationJobConflictError(
        "The encrypted chat transcript contains an invalid message.",
      );
    }
    return {
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
    };
  });
}

function progress(
  stage: string,
  percent: number,
  message: string,
  now = new Date(),
): ChatRelocationProgress {
  return { stage, percent, message, updatedAt: toISOString(now) };
}

function toJob(row: ChatRelocationJobRow): ChatRelocationJobSummary {
  return chatRelocationJobSummarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    chatId: row.chatId,
    state: row.state,
    stateRevision: row.stateRevision,
    idempotencyKey: row.idempotencyKey,
    sourcePlacement: row.sourcePlacement,
    sourcePlacementRevision: row.sourcePlacementRevision,
    targetPlacement: row.targetPlacement,
    contextSnapshotId: row.id,
    targetRuntimeThreadId: row.targetRuntimeThreadId,
    targetModelRouteId: row.targetModelRouteId,
    targetProviderAccountId: row.targetProviderAccountId,
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

function toSnapshot(
  row: ChatRelocationSnapshotRow,
): ChatRelocationSnapshotRecord {
  return {
    summary: chatRelocationSnapshotSummarySchema.parse({
      id: row.id,
      chatId: row.chatId,
      sourcePlacement: row.sourcePlacement,
      throughSequence: row.throughSequence,
      transcriptSha256: row.transcriptSha256,
      messageCount: row.messageCount,
      attachmentCount: row.attachmentCount,
      modelId: row.modelId,
      modelRouteId: row.modelRouteId,
      permissionProfileId: row.permissionProfileId,
      requiredRevision: row.requiredRevision,
      createdAt: toISOString(row.createdAt),
    }),
    payload: chatRelocationContextPayloadSchema.parse(row.payload),
  };
}

function toChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): ChatWireSummary {
  return chatWireSummarySchema.parse({
    id: chat.id,
    projectId: chat.projectId,
    titleProtection: chat.protectedLabel,
    experience: chat.experience,
    position: chat.position,
    status: chat.status,
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: chat.activeWorktreeId,
    placementRevision: chat.placementRevision,
    worktreeMode: chat.worktreeMode,
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    permissionProfileId: chat.permissionProfileId,
    planMode: chat.planMode,
    hasPendingPlanQuestion: chat.hasPendingPlanQuestion,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

function payloadFingerprint(
  chatId: string,
  targetPlacement: ExecutionPlacement,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ chatId, targetPlacement }))
    .digest("hex");
}

export function encodeChatRelocationPayload(
  payload: ChatRelocationContextPayload,
): Buffer {
  return encodeCanonicalChatPayload(payload);
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

function attachmentIds(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("type" in item) ||
      item.type !== "attachment" ||
      !("attachment" in item) ||
      typeof item.attachment !== "object" ||
      item.attachment === null ||
      !("id" in item.attachment) ||
      typeof item.attachment.id !== "string"
    ) {
      return [];
    }
    return [item.attachment.id];
  });
}

function chatIsExecuting(status: string): boolean {
  return status === "running" || status === "waiting-for-approval";
}

export class ChatRelocationJobRepository {
  constructor(private readonly database: ChatRelocationDatabase) {}

  async create(
    ownerId: string,
    chatId: string,
    target: ExecutionPlacement,
    idempotencyKey: string,
  ): Promise<ChatRelocationJobSummary> {
    const normalizedTarget = {
      ...target,
      surface: { kind: "chat" as const, id: chatId },
    };
    const fingerprint = payloadFingerprint(chatId, normalizedTarget);
    const existing = await this.database
      .select()
      .from(schema.chatRelocationJobs)
      .where(
        and(
          eq(schema.chatRelocationJobs.ownerId, ownerId),
          eq(schema.chatRelocationJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadFingerprint !== fingerprint) {
        throw new ChatRelocationJobConflictError(
          "This idempotency key is already attached to a different relocation request.",
        );
      }
      return toJob(existing[0]);
    }

    const now = new Date();
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction
          .select({ id: schema.chats.id })
          .from(schema.chats)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, schema.chats.projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(eq(schema.chats.id, chatId))
          .for("update");
        const rows = await transaction
          .select({
            chat: schema.chats,
            source: schema.projectSources,
            worktree: schema.projectWorktrees,
            runtime: schema.chatRuntimeSessions,
          })
          .from(schema.chats)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, schema.chats.projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .innerJoin(
            schema.projectWorktrees,
            eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
          )
          .innerJoin(
            schema.projectSources,
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
          )
          .leftJoin(
            schema.chatRuntimeSessions,
            and(
              eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
              eq(
                schema.chatRuntimeSessions.workerId,
                schema.projectWorktrees.workerId,
              ),
              eq(
                schema.chatRuntimeSessions.worktreeId,
                schema.projectWorktrees.id,
              ),
            ),
          )
          .where(eq(schema.chats.id, chatId))
          .limit(1);
        const context = rows[0];
        if (!context) {
          throw new ChatRelocationJobNotFoundError("Chat not found.");
        }
        if (
          context.chat.activeWorkerId !== null &&
          context.chat.activeWorkerId !== context.worktree.workerId
        ) {
          throw new ChatRelocationJobConflictError(
            "The chat source worker and active worktree do not match.",
          );
        }
        if (!context.worktree.head) {
          throw new ChatRelocationJobConflictError(
            "The source worktree revision has not been observed yet.",
          );
        }
        if (
          normalizedTarget.projectId !== context.chat.projectId ||
          !normalizedTarget.projectReplicaId ||
          !normalizedTarget.worktreeId
        ) {
          throw new ChatRelocationJobConflictError(
            "The relocation target is not a complete placement for this chat.",
          );
        }
        const targetRows = await transaction
          .select({
            source: schema.projectSources,
            worktree: schema.projectWorktrees,
          })
          .from(schema.projectWorktrees)
          .innerJoin(
            schema.projectSources,
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
          )
          .where(
            and(
              eq(schema.projectWorktrees.id, normalizedTarget.worktreeId),
              eq(schema.projectWorktrees.workerId, normalizedTarget.workerId),
              eq(schema.projectSources.id, normalizedTarget.projectReplicaId),
              eq(schema.projectSources.projectId, context.chat.projectId),
              isNull(schema.projectSources.removedAt),
              eq(schema.projectWorktrees.lifecycleState, "ready"),
            ),
          )
          .limit(1);
        if (!targetRows[0]) {
          throw new ChatRelocationJobConflictError(
            "The relocation target is not a ready project worktree.",
          );
        }
        const sourcePlacement: ExecutionPlacement = {
          projectId: context.chat.projectId,
          workerId: context.worktree.workerId,
          projectReplicaId: context.source.id,
          worktreeId: context.worktree.id,
          surface: { kind: "chat", id: chatId },
        };
        if (
          sourcePlacement.workerId === normalizedTarget.workerId &&
          sourcePlacement.worktreeId === normalizedTarget.worktreeId
        ) {
          throw new ChatRelocationJobConflictError(
            "The chat already uses the selected placement.",
          );
        }
        const activeJobs = await transaction
          .select({ id: schema.chatRelocationJobs.id })
          .from(schema.chatRelocationJobs)
          .where(
            and(
              eq(schema.chatRelocationJobs.chatId, chatId),
              inArray(schema.chatRelocationJobs.state, [...ACTIVE_STATES]),
            ),
          )
          .limit(1);
        if (activeJobs[0]) {
          throw new ChatRelocationJobConflictError(
            "This chat already has an active relocation.",
          );
        }

        const messages = await transaction
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, chatId))
          .orderBy(asc(schema.chatMessages.sequence));
        if (messages.length > 100_000) {
          throw new ChatRelocationJobConflictError(
            "The canonical transcript is too large to snapshot safely.",
          );
        }
        const referencedAttachmentIds = await relocationAttachmentIds(
          transaction,
          chatId,
          messages,
        );
        if (referencedAttachmentIds.length > 2_000) {
          throw new ChatRelocationJobConflictError(
            "The chat has too many referenced attachments to relocate safely.",
          );
        }
        const attachments = referencedAttachmentIds.length
          ? await transaction
              .select({
                attachment: schema.chatAttachments,
                replica: schema.chatAttachmentReplicas,
              })
              .from(schema.chatAttachments)
              .leftJoin(
                schema.chatAttachmentReplicas,
                and(
                  eq(
                    schema.chatAttachmentReplicas.attachmentId,
                    schema.chatAttachments.id,
                  ),
                  eq(schema.chatAttachmentReplicas.status, "ready"),
                ),
              )
              .where(
                and(
                  eq(schema.chatAttachments.chatId, chatId),
                  inArray(schema.chatAttachments.id, referencedAttachmentIds),
                ),
              )
          : [];
        const attachmentById = new Map(
          referencedAttachmentIds.map((attachmentId) => [
            attachmentId,
            attachments.filter(
              ({ attachment }) => attachment.id === attachmentId,
            ),
          ]),
        );
        if (
          [...attachmentById.values()].some((availability) => {
            const attachment = availability[0]?.attachment;
            return !attachment || attachment.status !== "ready";
          })
        ) {
          throw new ChatRelocationJobConflictError(
            "A referenced attachment is missing from canonical chat state.",
          );
        }
        const payload = chatRelocationContextPayloadSchema.parse({
          version: 1,
          kind:
            context.chat.experience === "task"
              ? "task-encrypted"
              : "chat-encrypted",
          messages: relocationMessages(context.chat.experience, messages),
          attachments: referencedAttachmentIds.map((attachmentId) => {
            const availability = attachmentById.get(attachmentId)!;
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
                    replica ? [replica.workerId] : [],
                  ),
                ),
              ].sort(),
            };
          }),
        });
        const digest = createHash("sha256")
          .update(encodeChatRelocationPayload(payload))
          .digest("hex");
        const jobId = randomUUID();
        const initialState = chatIsExecuting(context.chat.status)
          ? "waiting-for-idle"
          : "queued";
        const inserted = await transaction
          .insert(schema.chatRelocationJobs)
          .values({
            id: jobId,
            ownerId,
            projectId: context.chat.projectId,
            chatId,
            state: initialState,
            idempotencyKey,
            payloadFingerprint: fingerprint,
            sourcePlacement,
            sourcePlacementRevision: context.chat.placementRevision,
            targetPlacement: normalizedTarget,
            progress: progress(
              initialState,
              0,
              initialState === "waiting-for-idle"
                ? "Waiting for the active chat execution to reach an idle boundary."
                : "Relocation is queued for validation.",
              now,
            ),
            availableAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await transaction.insert(schema.chatRelocationSnapshots).values({
          id: jobId,
          jobId,
          chatId,
          sourcePlacement,
          throughSequence: messages.at(-1)?.sequence ?? 0,
          transcriptSha256: digest,
          payload,
          messageCount: payload.messages.length,
          attachmentCount: payload.attachments.length,
          modelId: context.chat.modelId,
          modelRouteId: context.runtime?.modelRouteId ?? null,
          permissionProfileId: context.chat.permissionProfileId,
          requiredRevision: context.worktree.head,
          createdAt: now,
        });
        return toJob(inserted[0]!);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.database
        .select()
        .from(schema.chatRelocationJobs)
        .where(
          and(
            eq(schema.chatRelocationJobs.ownerId, ownerId),
            eq(schema.chatRelocationJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (replay[0]?.payloadFingerprint === fingerprint) {
        return toJob(replay[0]);
      }
      throw new ChatRelocationJobConflictError(
        "This chat already has an active relocation.",
      );
    }
  }

  async get(
    ownerId: string,
    jobId: string,
  ): Promise<ChatRelocationJobSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.chatRelocationJobs)
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async list(
    ownerId: string,
    chatId: string,
  ): Promise<ChatRelocationJobSummary[]> {
    const rows = await this.database
      .select({ job: schema.chatRelocationJobs })
      .from(schema.chatRelocationJobs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chatRelocationJobs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatRelocationJobs.chatId, chatId))
      .orderBy(
        desc(schema.chatRelocationJobs.createdAt),
        desc(schema.chatRelocationJobs.id),
      )
      .limit(CHAT_RELOCATION_JOB_HISTORY_LIMIT);
    return chatRelocationJobListSchema.parse(
      rows.reverse().map(({ job }) => toJob(job)),
    );
  }

  async getSnapshot(
    ownerId: string,
    jobId: string,
  ): Promise<ChatRelocationSnapshotRecord | null> {
    const rows = await this.database
      .select({ snapshot: schema.chatRelocationSnapshots })
      .from(schema.chatRelocationSnapshots)
      .innerJoin(
        schema.chatRelocationJobs,
        and(
          eq(
            schema.chatRelocationJobs.id,
            schema.chatRelocationSnapshots.jobId,
          ),
          eq(schema.chatRelocationJobs.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatRelocationSnapshots.jobId, jobId))
      .limit(1);
    return rows[0] ? toSnapshot(rows[0].snapshot) : null;
  }

  private async refreshWaitingSnapshot(jobId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          job: schema.chatRelocationJobs,
          chat: schema.chats,
          worktree: schema.projectWorktrees,
          runtime: schema.chatRuntimeSessions,
        })
        .from(schema.chatRelocationJobs)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.chatRelocationJobs.chatId),
        )
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
        )
        .leftJoin(
          schema.chatRuntimeSessions,
          and(
            eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
            eq(
              schema.chatRuntimeSessions.workerId,
              schema.projectWorktrees.workerId,
            ),
            eq(
              schema.chatRuntimeSessions.worktreeId,
              schema.projectWorktrees.id,
            ),
          ),
        )
        .where(eq(schema.chatRelocationJobs.id, jobId))
        .limit(1);
      const context = rows[0];
      if (!context || context.job.state !== "waiting-for-idle") return;
      if (chatIsExecuting(context.chat.status)) return;
      if (
        context.chat.placementRevision !==
          context.job.sourcePlacementRevision ||
        context.worktree.id !== context.job.sourcePlacement.worktreeId ||
        context.worktree.workerId !== context.job.sourcePlacement.workerId
      ) {
        throw new ChatRelocationJobConflictError(
          "The source placement changed before the idle snapshot could be captured.",
        );
      }
      if (!context.worktree.head) {
        throw new ChatRelocationJobConflictError(
          "The source worktree revision has not been observed yet.",
        );
      }
      const messages = await transaction
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, context.chat.id))
        .orderBy(asc(schema.chatMessages.sequence));
      if (messages.length > 100_000) {
        throw new ChatRelocationJobConflictError(
          "The canonical transcript is too large to snapshot safely.",
        );
      }
      const referencedAttachmentIds = await relocationAttachmentIds(
        transaction,
        context.chat.id,
        messages,
      );
      if (referencedAttachmentIds.length > 2_000) {
        throw new ChatRelocationJobConflictError(
          "The chat has too many referenced attachments to relocate safely.",
        );
      }
      const attachments = referencedAttachmentIds.length
        ? await transaction
            .select({
              attachment: schema.chatAttachments,
              replica: schema.chatAttachmentReplicas,
            })
            .from(schema.chatAttachments)
            .leftJoin(
              schema.chatAttachmentReplicas,
              and(
                eq(
                  schema.chatAttachmentReplicas.attachmentId,
                  schema.chatAttachments.id,
                ),
                eq(schema.chatAttachmentReplicas.status, "ready"),
              ),
            )
            .where(
              and(
                eq(schema.chatAttachments.chatId, context.chat.id),
                inArray(schema.chatAttachments.id, referencedAttachmentIds),
              ),
            )
        : [];
      const attachmentById = new Map(
        referencedAttachmentIds.map((attachmentId) => [
          attachmentId,
          attachments.filter(
            ({ attachment }) => attachment.id === attachmentId,
          ),
        ]),
      );
      if (
        [...attachmentById.values()].some((availability) => {
          const attachment = availability[0]?.attachment;
          return !attachment || attachment.status !== "ready";
        })
      ) {
        throw new ChatRelocationJobConflictError(
          "A referenced attachment is missing from canonical chat state.",
        );
      }
      const payload = chatRelocationContextPayloadSchema.parse({
        version: 1,
        kind:
          context.chat.experience === "task"
            ? "task-encrypted"
            : "chat-encrypted",
        messages: relocationMessages(context.chat.experience, messages),
        attachments: referencedAttachmentIds.map((attachmentId) => {
          const availability = attachmentById.get(attachmentId)!;
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
                  replica ? [replica.workerId] : [],
                ),
              ),
            ].sort(),
          };
        }),
      });
      const digest = createHash("sha256")
        .update(encodeChatRelocationPayload(payload))
        .digest("hex");
      await transaction
        .update(schema.chatRelocationSnapshots)
        .set({
          throughSequence: messages.at(-1)?.sequence ?? 0,
          transcriptSha256: digest,
          payload,
          messageCount: payload.messages.length,
          attachmentCount: payload.attachments.length,
          modelId: context.chat.modelId,
          modelRouteId: context.runtime?.modelRouteId ?? null,
          permissionProfileId: context.chat.permissionProfileId,
          requiredRevision: context.worktree.head,
        })
        .where(eq(schema.chatRelocationSnapshots.jobId, context.job.id));
    });
  }

  async markAttachmentAvailable(
    attachmentId: string,
    workerId: string,
  ): Promise<void> {
    await this.database
      .insert(schema.chatAttachmentReplicas)
      .values({ attachmentId, workerId, status: "ready" })
      .onConflictDoUpdate({
        target: [
          schema.chatAttachmentReplicas.attachmentId,
          schema.chatAttachmentReplicas.workerId,
        ],
        set: {
          status: "ready",
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  async isAttachmentAvailable(
    attachmentId: string,
    workerId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ attachmentId: schema.chatAttachmentReplicas.attachmentId })
      .from(schema.chatAttachmentReplicas)
      .where(
        and(
          eq(schema.chatAttachmentReplicas.attachmentId, attachmentId),
          eq(schema.chatAttachmentReplicas.workerId, workerId),
          eq(schema.chatAttachmentReplicas.status, "ready"),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  async recoverInterrupted(force = true, now = new Date()): Promise<number> {
    await this.database
      .update(schema.chats)
      .set({ status: "idle", updatedAt: now })
      .where(
        and(
          eq(schema.chats.status, "failed"),
          sql`EXISTS (
            SELECT 1
            FROM ${schema.chatRelocationJobs}
            WHERE ${schema.chatRelocationJobs.chatId} = ${schema.chats.id}
              AND ${schema.chatRelocationJobs.state} IN ('queued', 'waiting-for-idle', 'validating', 'preparing-replica', 'transferring-attachments', 'hydrating-runtime', 'ready-to-commit', 'blocked')
          )`,
        ),
      );
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        cancellationUnsafeAt: null,
        availableAt: now,
        progress: progress(
          "recovering",
          0,
          "Recovered an interrupted relocation for safe replay.",
          now,
        ),
        updatedAt: now,
      })
      .where(
        and(
          inArray(schema.chatRelocationJobs.state, [...RUNNING_STATES]),
          force
            ? sql`TRUE`
            : or(
                isNull(schema.chatRelocationJobs.leaseExpiresAt),
                lte(schema.chatRelocationJobs.leaseExpiresAt, now),
              ),
        ),
      )
      .returning({ id: schema.chatRelocationJobs.id });
    return rows.length;
  }

  async renewLease(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        leaseExpiresAt: new Date(now.getTime() + CHAT_RELOCATION_JOB_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.commandId, commandId),
          eq(schema.chatRelocationJobs.attempt, attempt),
          inArray(schema.chatRelocationJobs.state, [...RUNNING_STATES]),
        ),
      )
      .returning({ id: schema.chatRelocationJobs.id });
    return rows.length === 1;
  }

  async requeueRetryableForWorker(workerId: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        availableAt: now,
        progress: progress(
          "queued",
          0,
          "A required worker reconnected; relocation validation will resume.",
          now,
        ),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.state, "blocked"),
          eq(schema.chatRelocationJobs.errorRetryable, true),
          or(
            sql`${schema.chatRelocationJobs.sourcePlacement}->>'workerId' = ${workerId}`,
            sql`${schema.chatRelocationJobs.targetPlacement}->>'workerId' = ${workerId}`,
          ),
        ),
      )
      .returning({ id: schema.chatRelocationJobs.id });
    return rows.length;
  }

  async claimNext(): Promise<ClaimedChatRelocationJob | null> {
    const now = new Date();
    const candidates = await this.database
      .select({
        job: schema.chatRelocationJobs,
        chatStatus: schema.chats.status,
      })
      .from(schema.chatRelocationJobs)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatRelocationJobs.chatId),
      )
      .where(
        and(
          or(
            eq(schema.chatRelocationJobs.state, "queued"),
            eq(schema.chatRelocationJobs.state, "waiting-for-idle"),
          ),
          lte(schema.chatRelocationJobs.availableAt, now),
        ),
      )
      .orderBy(
        asc(schema.chatRelocationJobs.availableAt),
        asc(schema.chatRelocationJobs.createdAt),
      )
      .limit(20);
    for (const candidate of candidates) {
      if (
        candidate.job.state === "waiting-for-idle" &&
        chatIsExecuting(candidate.chatStatus)
      ) {
        continue;
      }
      if (candidate.job.state === "waiting-for-idle") {
        try {
          await this.refreshWaitingSnapshot(candidate.job.id);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message.slice(0, 4_000)
              : "The idle relocation snapshot could not be refreshed.";
          await this.database
            .update(schema.chatRelocationJobs)
            .set({
              state: "failed",
              stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
              commandId: null,
              leaseExpiresAt: null,
              progress: progress("failed", 100, message, now),
              lastErrorCode: "stale-attempt",
              lastErrorMessage: message,
              errorRetryable: false,
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.chatRelocationJobs.id, candidate.job.id),
                eq(
                  schema.chatRelocationJobs.stateRevision,
                  candidate.job.stateRevision,
                ),
                eq(schema.chatRelocationJobs.state, "waiting-for-idle"),
              ),
            );
          continue;
        }
      }
      const commandId = randomUUID();
      const claimed = await this.database
        .update(schema.chatRelocationJobs)
        .set({
          state: "validating",
          stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
          attempt: sql`${schema.chatRelocationJobs.attempt} + 1`,
          commandId,
          startedAt: candidate.job.startedAt ?? now,
          leaseExpiresAt: new Date(
            now.getTime() + CHAT_RELOCATION_JOB_LEASE_MS,
          ),
          progress: progress(
            "validating",
            5,
            "Validating source and target placement.",
            now,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
          errorRetryable: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatRelocationJobs.id, candidate.job.id),
            eq(
              schema.chatRelocationJobs.stateRevision,
              candidate.job.stateRevision,
            ),
            inArray(schema.chatRelocationJobs.state, [
              "queued",
              "waiting-for-idle",
            ]),
          ),
        )
        .returning();
      if (!claimed[0]) continue;
      const snapshot = await this.getSnapshot(
        claimed[0].ownerId,
        claimed[0].id,
      );
      if (!snapshot) {
        throw new ChatRelocationJobNotFoundError(
          "Relocation context snapshot not found.",
        );
      }
      return {
        commandId,
        job: toJob(claimed[0]),
        ownerId: claimed[0].ownerId,
        snapshot,
      };
    }
    return null;
  }

  async advance(
    jobId: string,
    commandId: string,
    attempt: number,
    from: ChatRelocationJobSummary["state"],
    to: ChatRelocationJobSummary["state"],
    nextProgress: Omit<ChatRelocationProgress, "updatedAt">,
    options: {
      cancellationUnsafe?: boolean;
      targetModelRouteId?: string;
      targetProviderAccountId?: string | null;
      targetRuntimeThreadId?: string;
    } = {},
  ): Promise<ChatRelocationJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: to,
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        leaseExpiresAt: new Date(now.getTime() + CHAT_RELOCATION_JOB_LEASE_MS),
        progress: { ...nextProgress, updatedAt: toISOString(now) },
        ...(options.cancellationUnsafe ? { cancellationUnsafeAt: now } : {}),
        ...(options.targetRuntimeThreadId
          ? { targetRuntimeThreadId: options.targetRuntimeThreadId }
          : {}),
        ...(options.targetModelRouteId
          ? { targetModelRouteId: options.targetModelRouteId }
          : {}),
        ...(options.targetProviderAccountId === undefined
          ? {}
          : { targetProviderAccountId: options.targetProviderAccountId }),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.commandId, commandId),
          eq(schema.chatRelocationJobs.attempt, attempt),
          eq(schema.chatRelocationJobs.state, from),
        ),
      )
      .returning();
    if (!rows[0]) throw new ChatRelocationJobStaleAttemptError();
    return toJob(rows[0]);
  }

  async fail(
    jobId: string,
    commandId: string,
    attempt: number,
    error: ChatRelocationError,
  ): Promise<ChatRelocationJobSummary> {
    const now = new Date();
    const currentRows = await this.database
      .select()
      .from(schema.chatRelocationJobs)
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.commandId, commandId),
          eq(schema.chatRelocationJobs.attempt, attempt),
          inArray(schema.chatRelocationJobs.state, [...RUNNING_STATES]),
        ),
      )
      .limit(1);
    if (!currentRows[0]) throw new ChatRelocationJobStaleAttemptError();
    const current = toJob(currentRows[0]);
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: error.retryable ? "blocked" : "failed",
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        progress: error.retryable
          ? progress("blocked", current.progress.percent, error.message, now)
          : progress("failed", 100, error.message, now),
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        errorRetryable: error.retryable,
        completedAt: error.retryable ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.commandId, commandId),
          eq(schema.chatRelocationJobs.attempt, attempt),
          inArray(schema.chatRelocationJobs.state, [...RUNNING_STATES]),
        ),
      )
      .returning();
    if (!rows[0]) throw new ChatRelocationJobStaleAttemptError();
    return toJob(rows[0]);
  }

  async commit(
    jobId: string,
    commandId: string,
    attempt: number,
  ): Promise<{ chat: ChatWireSummary; job: ChatRelocationJobSummary }> {
    return this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(schema.chatRelocationJobs)
        .where(
          and(
            eq(schema.chatRelocationJobs.id, jobId),
            eq(schema.chatRelocationJobs.commandId, commandId),
            eq(schema.chatRelocationJobs.attempt, attempt),
            eq(schema.chatRelocationJobs.state, "ready-to-commit"),
          ),
        )
        .limit(1);
      const job = jobs[0];
      if (!job) throw new ChatRelocationJobStaleAttemptError();
      if (
        !job.targetRuntimeThreadId ||
        !job.targetModelRouteId ||
        !job.targetPlacement.worktreeId
      ) {
        throw new ChatRelocationJobConflictError(
          "The target runtime is not ready to commit.",
        );
      }
      const snapshots = await transaction
        .select({ id: schema.chatRelocationSnapshots.id })
        .from(schema.chatRelocationSnapshots)
        .where(eq(schema.chatRelocationSnapshots.jobId, job.id))
        .limit(1);
      if (!snapshots[0]) {
        throw new ChatRelocationJobConflictError(
          "The relocation context snapshot is missing.",
        );
      }
      const targetWorktrees = await transaction
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
          ),
        )
        .where(
          and(
            eq(schema.projectWorktrees.id, job.targetPlacement.worktreeId),
            eq(schema.projectWorktrees.workerId, job.targetPlacement.workerId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
          ),
        )
        .limit(1);
      const targetWorktree = targetWorktrees[0]?.worktree;
      if (!targetWorktree) {
        throw new ChatRelocationJobConflictError(
          "The target worktree is no longer ready to receive this chat.",
        );
      }
      const now = new Date();
      const chats = await transaction
        .update(schema.chats)
        .set({
          activeWorkerId: job.targetPlacement.workerId,
          activeWorktreeId: job.targetPlacement.worktreeId,
          placementRevision: sql`${schema.chats.placementRevision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chats.id, job.chatId),
            eq(schema.chats.projectId, job.projectId),
            eq(schema.chats.status, "idle"),
            or(
              eq(schema.chats.activeWorkerId, job.sourcePlacement.workerId),
              isNull(schema.chats.activeWorkerId),
            ),
            eq(schema.chats.activeWorktreeId, job.sourcePlacement.worktreeId!),
            eq(schema.chats.placementRevision, job.sourcePlacementRevision),
          ),
        )
        .returning();
      if (!chats[0]) {
        const failed = await transaction
          .update(schema.chatRelocationJobs)
          .set({
            state: "failed",
            stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
            commandId: null,
            leaseExpiresAt: null,
            progress: progress(
              "failed",
              100,
              "The source placement changed before relocation could commit.",
              now,
            ),
            lastErrorCode: "stale-attempt",
            lastErrorMessage:
              "The source placement changed before relocation could commit.",
            errorRetryable: false,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.chatRelocationJobs.id, job.id))
          .returning();
        const currentChats = await transaction
          .select()
          .from(schema.chats)
          .where(eq(schema.chats.id, job.chatId))
          .limit(1);
        if (!currentChats[0] || !failed[0]) {
          throw new ChatRelocationJobStaleAttemptError();
        }
        return {
          chat: toChatWireSummary(currentChats[0]),
          job: toJob(failed[0]),
        };
      }
      await transaction
        .update(schema.chatRuntimeSessions)
        .set({ status: "detached", updatedAt: now })
        .where(
          and(
            eq(schema.chatRuntimeSessions.chatId, job.chatId),
            eq(
              schema.chatRuntimeSessions.workerId,
              job.sourcePlacement.workerId,
            ),
            eq(
              schema.chatRuntimeSessions.worktreeId,
              job.sourcePlacement.worktreeId!,
            ),
          ),
        );
      const runtimeRows = await transaction
        .insert(schema.chatRuntimeSessions)
        .values({
          id: randomUUID(),
          chatId: job.chatId,
          workerId: job.targetPlacement.workerId,
          worktreeId: job.targetPlacement.worktreeId,
          codexThreadId: job.targetRuntimeThreadId,
          modelRouteId: job.targetModelRouteId,
          providerAccountId: job.targetProviderAccountId,
          status: "ready",
        })
        .onConflictDoUpdate({
          target: [
            schema.chatRuntimeSessions.chatId,
            schema.chatRuntimeSessions.workerId,
            schema.chatRuntimeSessions.worktreeId,
          ],
          set: {
            codexThreadId: job.targetRuntimeThreadId,
            modelRouteId: job.targetModelRouteId,
            providerAccountId: job.targetProviderAccountId,
            status: "ready",
            updatedAt: now,
          },
        })
        .returning();
      const runtime = runtimeRows[0]!;
      await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(
          and(
            eq(schema.chatExecutionLanes.chatId, job.chatId),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        );
      const targetLanes = await transaction
        .select({ id: schema.chatExecutionLanes.id })
        .from(schema.chatExecutionLanes)
        .where(
          and(
            eq(schema.chatExecutionLanes.chatId, job.chatId),
            eq(
              schema.chatExecutionLanes.worktreeId,
              job.targetPlacement.worktreeId,
            ),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        )
        .limit(1);
      let targetLaneId: string;
      if (targetLanes[0]) {
        targetLaneId = targetLanes[0].id;
        await transaction
          .update(schema.chatExecutionLanes)
          .set({
            workerId: job.targetPlacement.workerId,
            purpose: `Relocated by job ${job.id}`,
            state: "suspended",
            runtimeSessionId: runtime.id,
            codexThreadId: job.targetRuntimeThreadId,
            updatedAt: now,
          })
          .where(eq(schema.chatExecutionLanes.id, targetLanes[0].id));
      } else {
        targetLaneId = randomUUID();
        await transaction.insert(schema.chatExecutionLanes).values({
          id: targetLaneId,
          chatId: job.chatId,
          worktreeId: job.targetPlacement.worktreeId,
          workerId: job.targetPlacement.workerId,
          acquiringActor: "user",
          exclusive: !targetWorktree.isPrimary,
          purpose: `Relocated by job ${job.id}`,
          state: "suspended",
          runtimeSessionId: runtime.id,
          codexThreadId: job.targetRuntimeThreadId,
        });
      }
      try {
        await acquireChatLogicalBranchLease(transaction, {
          branchName: targetWorktree.branch,
          chatId: job.chatId,
          detached: targetWorktree.detached,
          laneId: targetLaneId,
          projectId: job.projectId,
          workerId: job.targetPlacement.workerId,
          worktreeId: job.targetPlacement.worktreeId,
        });
      } catch (error) {
        if (error instanceof LogicalBranchLeaseConflictError) {
          throw new ChatRelocationJobConflictError(error.message);
        }
        throw error;
      }
      if (targetWorktree.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, targetLaneId);
      }
      await transaction
        .update(schema.terminals)
        .set({
          activeWorkerId: job.targetPlacement.workerId,
          worktreeId: job.targetPlacement.worktreeId,
          status: "idle",
          updatedAt: now,
        })
        .where(eq(schema.terminals.linkedChatId, job.chatId));
      const completed = await transaction
        .update(schema.chatRelocationJobs)
        .set({
          state: "succeeded",
          stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
          commandId: null,
          leaseExpiresAt: null,
          progress: progress(
            "succeeded",
            100,
            "Chat placement changed successfully.",
            now,
          ),
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.chatRelocationJobs.id, job.id),
            eq(schema.chatRelocationJobs.commandId, commandId),
            eq(schema.chatRelocationJobs.attempt, attempt),
            eq(schema.chatRelocationJobs.state, "ready-to-commit"),
          ),
        )
        .returning();
      if (!completed[0]) throw new ChatRelocationJobStaleAttemptError();
      return {
        chat: toChatWireSummary(chats[0]),
        job: toJob(completed[0]),
      };
    });
  }

  async cancel(
    ownerId: string,
    jobId: string,
    stateRevision: number,
  ): Promise<ChatRelocationJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: "cancelled",
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        progress: progress("cancelled", 100, "Relocation cancelled.", now),
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.ownerId, ownerId),
          eq(schema.chatRelocationJobs.stateRevision, stateRevision),
          inArray(schema.chatRelocationJobs.state, [
            "queued",
            "waiting-for-idle",
            "validating",
            "preparing-replica",
            "transferring-attachments",
            "hydrating-runtime",
            "blocked",
          ]),
          isNull(schema.chatRelocationJobs.cancellationUnsafeAt),
        ),
      )
      .returning();
    if (!rows[0]) {
      const current = await this.get(ownerId, jobId);
      if (!current) throw new ChatRelocationJobNotFoundError();
      throw new ChatRelocationJobConflictError(
        "The relocation changed or can no longer be cancelled safely.",
      );
    }
    return toJob(rows[0]);
  }

  async retry(
    ownerId: string,
    jobId: string,
    stateRevision: number,
  ): Promise<ChatRelocationJobSummary> {
    const now = new Date();
    const rows = await this.database
      .update(schema.chatRelocationJobs)
      .set({
        state: "queued",
        stateRevision: sql`${schema.chatRelocationJobs.stateRevision} + 1`,
        commandId: null,
        leaseExpiresAt: null,
        cancellationUnsafeAt: null,
        availableAt: now,
        progress: progress("queued", 0, "Relocation queued for retry.", now),
        lastErrorCode: null,
        lastErrorMessage: null,
        errorRetryable: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chatRelocationJobs.id, jobId),
          eq(schema.chatRelocationJobs.ownerId, ownerId),
          eq(schema.chatRelocationJobs.stateRevision, stateRevision),
          or(
            eq(schema.chatRelocationJobs.state, "blocked"),
            eq(schema.chatRelocationJobs.state, "failed"),
          ),
        ),
      )
      .returning();
    if (!rows[0]) {
      const current = await this.get(ownerId, jobId);
      if (!current) throw new ChatRelocationJobNotFoundError();
      throw new ChatRelocationJobConflictError(
        "The relocation changed or is not retryable.",
      );
    }
    return toJob(rows[0]);
  }
}
