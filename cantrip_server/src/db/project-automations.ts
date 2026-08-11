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
import { and, desc, eq } from "drizzle-orm";
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

export interface ClaimedProjectAutomation {
  automation: ProjectAutomation;
  nextRunAt: Date | null;
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

  async listForWorker(workerId: string): Promise<ProjectAutomation[]> {
    const rows = await this.database
      .select({
        automation: schema.projectAutomations,
        chatTitle: schema.chats.title,
      })
      .from(schema.projectAutomations)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.projectAutomations.chatId),
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
    workerId: string,
    automationId: string,
    input: ProjectAutomationDispatchRequest,
    now = new Date(),
  ): Promise<ClaimedProjectAutomation | null> {
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
        .where(eq(schema.projectAutomations.id, automationId))
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
      const updated = await transaction
        .update(schema.projectAutomations)
        .set({
          nextRunAt,
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
      if (!updated[0]) return null;
      return {
        automation: toAutomation(
          updated[0],
          selected.chatTitle,
          selected.workerId,
        ),
        nextRunAt,
      };
    });
  }

  async finishDispatch(
    automationId: string,
    status: "started" | "queued" | "failed",
    error: string | null = null,
  ): Promise<void> {
    await this.database
      .update(schema.projectAutomations)
      .set({
        lastStatus: status,
        lastError: error?.slice(0, 5_000) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.projectAutomations.id, automationId));
  }
}
