import { randomUUID } from "node:crypto";

import {
  firstProjectAutomationRunAt,
  nextProjectAutomationRunAt,
  projectAutomationListSchema,
  projectAutomationSchema,
  type ProjectAutomation,
  type ProjectAutomationCreate,
  type ProjectAutomationDispatchRequest,
  type ProjectAutomationSchedule,
  type ProjectAutomationUpdate,
} from "@cantrip/protocol/automations";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type AutomationDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type AutomationRow = typeof schema.projectAutomations.$inferSelect;

export class ProjectAutomationConflictError extends Error {}

function toISOString(value: Date): string {
  return value.toISOString();
}

function toAutomation(
  row: AutomationRow,
  chatTitle: string,
  workerId: string,
): ProjectAutomation {
  return projectAutomationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    chatId: row.chatId,
    chatTitle,
    workerId,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    condition: row.condition,
    enabled: row.enabled,
    revision: row.revision,
    nextRunAt: row.nextRunAt ? toISOString(row.nextRunAt) : null,
    lastRunAt: row.lastRunAt ? toISOString(row.lastRunAt) : null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function nextRunFor(
  enabled: boolean,
  schedule: ProjectAutomationSchedule,
  now: Date,
): Date | null {
  return enabled ? firstProjectAutomationRunAt(schedule, now) : null;
}

export interface ProjectAutomationDispatchLease {
  automation: ProjectAutomation;
  dispatchInstanceId: string;
  fencingToken: number;
  leaseToken: string;
  nextRunAt: Date | null;
  runId: string;
  scheduledFor: Date;
}

export class ProjectAutomationRepository {
  constructor(private readonly database: AutomationDatabase) {}

  private async target(
    ownerId: string,
    projectId: string,
    chatId: string,
  ): Promise<{ chatTitle: string; workerId: string } | null> {
    const rows = await this.database
      .select({
        chatTitle: schema.chats.title,
        workerId: schema.projectWorktrees.workerId,
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
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.projectId, projectId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(
    ownerId: string,
    projectId: string,
    input: ProjectAutomationCreate,
  ): Promise<ProjectAutomation | null> {
    const target = await this.target(ownerId, projectId, input.chatId);
    if (!target) return null;
    const now = new Date();
    const nextRunAt = nextRunFor(input.enabled, input.schedule, now);
    if (input.enabled && !nextRunAt) {
      throw new ProjectAutomationConflictError(
        "This schedule has no future occurrence.",
      );
    }
    const rows = await this.database
      .insert(schema.projectAutomations)
      .values({
        id: randomUUID(),
        ownerId,
        projectId,
        chatId: input.chatId,
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        condition: input.condition,
        enabled: input.enabled,
        revision: 1,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toAutomation(rows[0]!, target.chatTitle, target.workerId);
  }

  async list(ownerId: string, projectId: string): Promise<ProjectAutomation[]> {
    const rows = await this.database
      .select({
        automation: schema.projectAutomations,
        chatTitle: schema.chats.title,
        workerId: schema.projectWorktrees.workerId,
      })
      .from(schema.projectAutomations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectAutomations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.projectAutomations.chatId),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
      )
      .where(eq(schema.projectAutomations.projectId, projectId))
      .orderBy(desc(schema.projectAutomations.createdAt));
    return projectAutomationListSchema.parse(
      rows.map(({ automation, chatTitle, workerId }) =>
        toAutomation(automation, chatTitle, workerId),
      ),
    );
  }

  async listForWorker(
    ownerId: string,
    workerId: string,
  ): Promise<ProjectAutomation[]> {
    const rows = await this.database
      .select({
        automation: schema.projectAutomations,
        chatTitle: schema.chats.title,
      })
      .from(schema.projectAutomations)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.projectAutomations.chatId),
          eq(schema.projectAutomations.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
          eq(schema.projectWorktrees.workerId, workerId),
        ),
      )
      .where(eq(schema.projectAutomations.enabled, true))
      .orderBy(schema.projectAutomations.nextRunAt);
    return projectAutomationListSchema.parse(
      rows.map(({ automation, chatTitle }) =>
        toAutomation(automation, chatTitle, workerId),
      ),
    );
  }

  async get(
    ownerId: string,
    automationId: string,
  ): Promise<ProjectAutomation | null> {
    const rows = await this.database
      .select({
        automation: schema.projectAutomations,
        chatTitle: schema.chats.title,
        workerId: schema.projectWorktrees.workerId,
      })
      .from(schema.projectAutomations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectAutomations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.projectAutomations.chatId),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
      )
      .where(eq(schema.projectAutomations.id, automationId))
      .limit(1);
    const row = rows[0];
    return row
      ? toAutomation(row.automation, row.chatTitle, row.workerId)
      : null;
  }

  async update(
    ownerId: string,
    automationId: string,
    input: ProjectAutomationUpdate,
  ): Promise<ProjectAutomation | null> {
    const current = await this.get(ownerId, automationId);
    if (!current) return null;
    const chatId = input.chatId ?? current.chatId;
    const target = await this.target(ownerId, current.projectId, chatId);
    if (!target) {
      throw new ProjectAutomationConflictError(
        "The target chat does not belong to this project.",
      );
    }
    const enabled = input.enabled ?? current.enabled;
    const schedule = input.schedule ?? current.schedule;
    const refreshSchedule =
      input.schedule !== undefined ||
      input.chatId !== undefined ||
      (input.enabled === true && !current.enabled);
    const nextRunAt = !enabled
      ? null
      : refreshSchedule
        ? nextRunFor(true, schedule, new Date())
        : current.nextRunAt
          ? new Date(current.nextRunAt)
          : nextRunFor(true, schedule, new Date());
    if (enabled && !nextRunAt) {
      throw new ProjectAutomationConflictError(
        "This schedule has no future occurrence.",
      );
    }
    const rows = await this.database
      .update(schema.projectAutomations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.condition !== undefined
          ? { condition: input.condition }
          : {}),
        chatId,
        schedule,
        enabled,
        revision: current.revision + 1,
        nextRunAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projectAutomations.id, automationId),
          eq(schema.projectAutomations.ownerId, ownerId),
          eq(schema.projectAutomations.revision, current.revision),
        ),
      )
      .returning();
    return rows[0]
      ? toAutomation(rows[0], target.chatTitle, target.workerId)
      : null;
  }

  async delete(ownerId: string, automationId: string): Promise<boolean> {
    const rows = await this.database
      .delete(schema.projectAutomations)
      .where(
        and(
          eq(schema.projectAutomations.id, automationId),
          eq(schema.projectAutomations.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.projectAutomations.id });
    return Boolean(rows[0]);
  }

  async claimDue(
    ownerId: string,
    workerId: string,
    automationId: string,
    input: ProjectAutomationDispatchRequest,
    dispatchInstanceId: string,
    leaseTtlMs: number,
    now = new Date(),
  ): Promise<ProjectAutomationDispatchLease | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          automation: schema.projectAutomations,
          chatTitle: schema.chats.title,
          workerId: schema.projectWorktrees.workerId,
        })
        .from(schema.projectAutomations)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.projectAutomations.chatId),
        )
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
        )
        .where(
          and(
            eq(schema.projectAutomations.id, automationId),
            eq(schema.projectAutomations.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const selected = rows[0];
      if (!selected || selected.workerId !== workerId) return null;
      const row = selected.automation;
      const expected = row.nextRunAt;
      if (
        !row.enabled ||
        row.revision !== input.revision ||
        !expected ||
        expected.toISOString() !== input.scheduledFor ||
        expected.getTime() > now.getTime() + 30_000
      ) {
        return null;
      }
      // Run one missed occurrence, then advance to the first future slot. This
      // prevents a worker that was offline from replaying a large backlog while
      // still preserving the schedule's original calendar anchor.
      const nextRunAt = nextProjectAutomationRunAt(
        row.schedule,
        new Date(Math.max(now.getTime(), expected.getTime())),
      );
      const existingRuns = await transaction
        .select()
        .from(schema.projectAutomationRuns)
        .where(
          and(
            eq(schema.projectAutomationRuns.automationId, automationId),
            eq(schema.projectAutomationRuns.scheduledFor, expected),
          ),
        )
        .for("update")
        .limit(1);
      const existing = existingRuns[0];
      if (existing && existing.status !== "dispatching") return null;
      if (existing && existing.leaseExpiresAt.getTime() > now.getTime()) {
        return null;
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
      const run = existing
        ? (
            await transaction
              .update(schema.projectAutomationRuns)
              .set({
                dispatchInstanceId,
                leaseToken,
                fencingToken: existing.fencingToken + 1,
                leaseExpiresAt,
                attemptCount: existing.attemptCount + 1,
                errorMessage: null,
                claimedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.projectAutomationRuns.id, existing.id),
                  eq(
                    schema.projectAutomationRuns.fencingToken,
                    existing.fencingToken,
                  ),
                  lte(schema.projectAutomationRuns.leaseExpiresAt, now),
                  eq(schema.projectAutomationRuns.status, "dispatching"),
                ),
              )
              .returning()
          )[0]
        : (
            await transaction
              .insert(schema.projectAutomationRuns)
              .values({
                id: randomUUID(),
                automationId,
                ownerId,
                projectId: row.projectId,
                chatId: row.chatId,
                workerId,
                automationRevision: row.revision,
                scheduledFor: expected,
                status: "dispatching",
                dispatchInstanceId,
                leaseToken,
                fencingToken: 1,
                leaseExpiresAt,
                attemptCount: 1,
                claimedAt: now,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
          )[0];
      if (!run) return null;
      const updated = await transaction
        .update(schema.projectAutomations)
        .set({
          lastRunAt: expected,
          lastStatus: "dispatching",
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectAutomations.id, automationId),
            eq(schema.projectAutomations.revision, input.revision),
            eq(schema.projectAutomations.nextRunAt, expected),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ProjectAutomationConflictError(
          "The automation changed while its occurrence was claimed.",
        );
      }
      return {
        automation: toAutomation(
          updated[0],
          selected.chatTitle,
          selected.workerId,
        ),
        dispatchInstanceId,
        fencingToken: run.fencingToken,
        leaseToken,
        nextRunAt,
        runId: run.id,
        scheduledFor: expected,
      };
    });
  }

  async finishDispatch(
    lease: ProjectAutomationDispatchLease,
    status: "started" | "queued" | "skipped" | "failed",
    error: string | null = null,
    now = new Date(),
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const runs = await transaction
        .update(schema.projectAutomationRuns)
        .set({
          status,
          errorMessage: error?.slice(0, 5_000) ?? null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectAutomationRuns.id, lease.runId),
            eq(
              schema.projectAutomationRuns.dispatchInstanceId,
              lease.dispatchInstanceId,
            ),
            eq(schema.projectAutomationRuns.leaseToken, lease.leaseToken),
            eq(schema.projectAutomationRuns.fencingToken, lease.fencingToken),
            eq(schema.projectAutomationRuns.status, "dispatching"),
            gt(schema.projectAutomationRuns.leaseExpiresAt, now),
          ),
        )
        .returning({ id: schema.projectAutomationRuns.id });
      if (!runs[0]) return false;
      await transaction
        .update(schema.projectAutomations)
        .set({
          nextRunAt: lease.nextRunAt,
          lastRunAt: lease.scheduledFor,
          lastStatus: status,
          lastError: error?.slice(0, 5_000) ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectAutomations.id, lease.automation.id),
            eq(schema.projectAutomations.revision, lease.automation.revision),
            eq(schema.projectAutomations.nextRunAt, lease.scheduledFor),
          ),
        );
      return true;
    });
  }
}
