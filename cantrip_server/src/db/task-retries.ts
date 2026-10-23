import { randomUUID } from "node:crypto";
import type { TaskFailureKind } from "@cantrip/protocol/tasks";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as schema from "./schema.js";
import {
  scheduleTaskRetry,
  TASK_RETRY_CLAIM_MS,
  TASK_RETRY_LIMIT,
  TASK_RETRY_WINDOW_MS,
  type TaskRetryRecord,
} from "../tasks/automatic-retry.js";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A separate operational ledger: retry accounting never changes encrypted Task revisions. */
export class TaskRetryRepository {
  constructor(private readonly database: Database) {}

  async listCandidates(now = Date.now()) {
    return this.database
      .select({
        ownerId: schema.chats.ownerId,
        chatId: schema.tasks.chatId,
        projectId: schema.chats.projectId,
      })
      .from(schema.tasks)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.chats.projectId),
      )
      .where(
        and(
          isNull(schema.chats.archivedAt),
          eq(schema.chats.automationPaused, false),
          eq(schema.projects.taskSchedulingPaused, false),
          notInArray(schema.chats.status, ["running", "waiting-for-approval"]),
          sql`not exists (select 1 from ${schema.agentInteractionRequests} where ${schema.agentInteractionRequests.chatId} = ${schema.chats.id} and ${schema.agentInteractionRequests.status} = 'pending')`,
          or(
            and(
              eq(schema.tasks.state, "failed"),
              isNull(schema.tasks.automaticRetry),
              isNotNull(schema.tasks.lastError),
            ),
            sql`(${schema.tasks.automaticRetry}->>'status' = 'scheduled' and (${schema.tasks.automaticRetry}->>'dueAt')::double precision <= ${now})`,
            sql`(${schema.tasks.automaticRetry}->>'status' = 'retrying' and (${schema.tasks.automaticRetry}->'claim'->>'expiresAt')::double precision <= ${now})`,
          ),
        ),
      )
      .orderBy(asc(schema.tasks.updatedAt));
  }

  private async mutate<T>(
    ownerId: string,
    chatId: string,
    action: (
      row: {
        task: typeof schema.tasks.$inferSelect;
        chat: typeof schema.chats.$inferSelect;
        project: typeof schema.projects.$inferSelect;
      },
      pendingInput: boolean,
    ) => { record: TaskRetryRecord | null; result: T },
  ) {
    return this.database.transaction(async (transaction) => {
      // Same lock order as enqueue/recovery. Claims across server replicas serialize.
      await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      const [row] = await transaction
        .select({
          task: schema.tasks,
          chat: schema.chats,
          project: schema.projects,
        })
        .from(schema.tasks)
        .innerJoin(schema.chats, eq(schema.chats.id, schema.tasks.chatId))
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.chats.projectId),
        )
        .where(
          and(
            eq(schema.tasks.chatId, chatId),
            eq(schema.chats.ownerId, ownerId),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return null;
      const input = await transaction
        .select({ id: schema.agentInteractionRequests.id })
        .from(schema.agentInteractionRequests)
        .where(
          and(
            eq(schema.agentInteractionRequests.chatId, chatId),
            eq(schema.agentInteractionRequests.status, "pending"),
          ),
        )
        .limit(1);
      const next = action(row, input.length > 0);
      if (
        JSON.stringify(next.record) !== JSON.stringify(row.task.automaticRetry)
      )
        await transaction
          .update(schema.tasks)
          .set({ automaticRetry: next.record })
          .where(eq(schema.tasks.chatId, chatId));
      return next.result;
    });
  }

  async noteFailure(
    ownerId: string,
    chatId: string,
    key: string,
    kind: TaskFailureKind,
    now = Date.now(),
  ) {
    return this.mutate(ownerId, chatId, ({ task }) => {
      if (task.state === "complete") return { record: null, result: false };
      const record = scheduleTaskRetry(task.automaticRetry, key, kind, now);
      return { record, result: record !== task.automaticRetry };
    });
  }

  async reset(ownerId: string, chatId: string) {
    return this.mutate(ownerId, chatId, () => ({ record: null, result: true }));
  }

  async clearPending(ownerId: string, chatId: string) {
    return this.mutate(ownerId, chatId, ({ task }) => ({
      record:
        task.state === "complete"
          ? null
          : ["blocked", "review"].includes(task.state) &&
              task.automaticRetry &&
              task.automaticRetry.status !== "latched"
            ? {
                ...task.automaticRetry,
                status: "idle",
                dueAt: null,
                claim: null,
              }
            : task.automaticRetry,
      result: true,
    }));
  }

  async claimDue(ownerId: string, chatId: string, now = Date.now()) {
    return this.mutate(
      ownerId,
      chatId,
      ({ task, chat, project }, pendingInput) => {
        let record = task.automaticRetry;
        const noClaim = () => ({
          record,
          result: null as { id: string; rowVersion: number } | null,
        });
        if (!record || !["scheduled", "retrying"].includes(record.status))
          return noClaim();
        if (task.state === "complete" || task.state === "blocked") {
          record = { ...record, status: "idle", claim: null, dueAt: null };
          return noClaim();
        }
        if (
          chat.automationPaused ||
          project.taskSchedulingPaused ||
          pendingInput ||
          ["running", "waiting-for-approval"].includes(chat.status)
        )
          return noClaim();
        if (record.claim && record.claim.expiresAt > now) return noClaim();
        if (
          record.status === "scheduled" &&
          (record.dueAt === null || record.dueAt > now)
        )
          return noClaim();
        const attempts = record.attempts.filter(
          (at) => at > now - TASK_RETRY_WINDOW_MS,
        );
        if (attempts.length >= TASK_RETRY_LIMIT) {
          record = {
            ...record,
            status: "latched",
            attempts,
            claim: null,
            dueAt: null,
          };
          return noClaim();
        }
        const id = randomUUID();
        record = {
          ...record,
          status: "retrying",
          attempts: [...attempts, now],
          dueAt: null,
          claim: { id, expiresAt: now + TASK_RETRY_CLAIM_MS },
        };
        return { record, result: { id, rowVersion: task.rowVersion } };
      },
    );
  }

  async finish(
    ownerId: string,
    chatId: string,
    claimId: string,
    failure?: { kind: TaskFailureKind; defer?: boolean },
    now = Date.now(),
  ) {
    return this.mutate(ownerId, chatId, ({ task }) => {
      let record = task.automaticRetry;
      if (!record || record.claim?.id !== claimId)
        return { record, result: false };
      if (failure) {
        if (failure.defer)
          record = { ...record, attempts: record.attempts.slice(0, -1) };
        record = scheduleTaskRetry(
          record,
          `retry:${claimId}`,
          failure.kind,
          now,
        );
      } else record = { ...record, status: "idle", claim: null, dueAt: null };
      return { record, result: true };
    });
  }
}
