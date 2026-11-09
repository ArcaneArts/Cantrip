import { randomUUID } from "node:crypto";

import {
  projectTaskPauseStateSchema,
  taskWorkerContinuityFamilySchema,
  taskWorkerListSchema,
  taskWorkerSummarySchema,
  type ProjectTaskPauseState,
  type ProjectTaskPauseUpdate,
  type TaskWorkerCreate,
  type TaskWorkerOrderUpdate,
  type TaskWorkerSummary,
  type TaskWorkerUpdate,
} from "@cantrip/protocol/task-scheduling";
import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

type TaskSchedulingDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type TaskWorkerRow = typeof schema.taskWorkers.$inferSelect;

const TRUSTED_CONTINUITY_METADATA_SOURCES = new Set([
  "codex",
  "grok",
  "ollama",
  "zai",
]);

export class TaskSchedulingConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-order"
      | "model-incompatible"
      | "model-unavailable"
      | "stale-version",
  ) {
    super(message);
    this.name = "TaskSchedulingConflictError";
  }
}

function iso(value: Date): string {
  return value.toISOString();
}

function fallbackContinuityFamily(modelId: string): string {
  return `model:${modelId}`;
}

function normalizedCatalogFamily(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/gu, "-");
  const parsed = taskWorkerContinuityFamilySchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function modelConfiguration(row: TaskWorkerRow) {
  return {
    modelId: row.modelId,
    reasoningEffort: row.reasoningEffort,
    customSubagentModel: row.customSubagentModel,
    subagentModelId: row.subagentModelId,
    subagentReasoningEffort: row.subagentReasoningEffort,
  };
}

function toTaskWorkerSummary(
  row: TaskWorkerRow,
  activeTaskCount = 0,
): TaskWorkerSummary {
  return taskWorkerSummarySchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    modelConfiguration: modelConfiguration(row),
    maxConcurrency: row.maxConcurrency,
    allowsPlanGoal: row.allowsPlanGoal,
    continuityFamily: row.continuityFamily,
    continuityFamilyOverride: row.continuityFamilyOverride,
    position: row.position,
    activeTaskCount,
    rowVersion: row.rowVersion,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export class TaskSchedulingRepository {
  constructor(private readonly database: TaskSchedulingDatabase) {}

  private async inferContinuityFamily(
    ownerId: string,
    modelId: string,
  ): Promise<string> {
    const rows = await this.database
      .select({
        family: schema.providerModels.family,
        metadataSource: schema.providerModels.metadataSource,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.providerModels,
        and(
          eq(schema.providerModels.id, schema.modelRoutes.providerModelId),
          eq(schema.providerModels.providerId, schema.modelRoutes.providerId),
        ),
      )
      .where(
        and(
          eq(schema.modelRoutes.modelId, modelId),
          eq(schema.modelRoutes.enabled, true),
        ),
      );
    const families = new Set(
      rows.flatMap(({ family, metadataSource }) => {
        if (!TRUSTED_CONTINUITY_METADATA_SOURCES.has(metadataSource)) return [];
        const normalized = normalizedCatalogFamily(family);
        return normalized ? [normalized] : [];
      }),
    );
    return families.size === 1
      ? [...families][0]!
      : fallbackContinuityFamily(modelId);
  }

  private async assertOwnedModels(
    ownerId: string,
    modelIds: readonly string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(modelIds)];
    const rows = await this.database
      .select({ id: schema.modelProfiles.id })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.ownerId, ownerId),
          inArray(schema.modelProfiles.id, uniqueIds),
        ),
      );
    if (rows.length !== uniqueIds.length) {
      throw new TaskSchedulingConflictError(
        "A selected Task Worker model is unavailable.",
        "model-unavailable",
      );
    }
  }

  private async assertCompatibleSubagentModel(
    ownerId: string,
    rootModelId: string,
    subagentModelId: string,
  ): Promise<void> {
    const routes = await this.database
      .select({
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
      .where(
        and(
          inArray(schema.modelRoutes.modelId, [rootModelId, subagentModelId]),
          eq(schema.modelRoutes.enabled, true),
        ),
      );
    const rootProviders = new Set(
      routes.flatMap(({ modelId, providerId }) =>
        modelId === rootModelId ? [providerId] : [],
      ),
    );
    if (
      !routes.some(
        ({ modelId, providerId }) =>
          modelId === subagentModelId && rootProviders.has(providerId),
      )
    ) {
      throw new TaskSchedulingConflictError(
        "Task Worker root and subagent models must share an enabled provider.",
        "model-incompatible",
      );
    }
  }

  async listTaskWorkers(ownerId: string): Promise<TaskWorkerSummary[]> {
    const [rows, activeCounts] = await Promise.all([
      this.database
        .select()
        .from(schema.taskWorkers)
        .where(
          and(
            eq(schema.taskWorkers.ownerId, ownerId),
            isNull(schema.taskWorkers.deletedAt),
          ),
        )
        .orderBy(asc(schema.taskWorkers.position), asc(schema.taskWorkers.id)),
      this.database
        .select({
          taskWorkerId: schema.taskDispatchCycles.selectedTaskWorkerId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, ownerId),
            inArray(schema.taskDispatchCycles.state, ["claimed", "running"]),
          ),
        )
        .groupBy(schema.taskDispatchCycles.selectedTaskWorkerId),
    ]);
    const countById = new Map(
      activeCounts.flatMap(({ taskWorkerId, count }) =>
        taskWorkerId ? [[taskWorkerId, count] as const] : [],
      ),
    );
    return taskWorkerListSchema.parse(
      rows.map((row) => toTaskWorkerSummary(row, countById.get(row.id) ?? 0)),
    );
  }

  async createTaskWorker(
    ownerId: string,
    input: TaskWorkerCreate,
  ): Promise<TaskWorkerSummary> {
    const rootModelId = input.modelConfiguration.modelId;
    if (!rootModelId) {
      throw new TaskSchedulingConflictError(
        "A Task Worker root model must be selected.",
        "model-unavailable",
      );
    }
    const modelIds = [
      rootModelId,
      ...(input.modelConfiguration.customSubagentModel &&
      input.modelConfiguration.subagentModelId
        ? [input.modelConfiguration.subagentModelId]
        : []),
    ];
    await this.assertOwnedModels(ownerId, modelIds);
    if (
      input.modelConfiguration.customSubagentModel &&
      input.modelConfiguration.subagentModelId
    ) {
      await this.assertCompatibleSubagentModel(
        ownerId,
        rootModelId,
        input.modelConfiguration.subagentModelId,
      );
    }
    const positions = await this.database
      .select({ value: max(schema.taskWorkers.position) })
      .from(schema.taskWorkers)
      .where(
        and(
          eq(schema.taskWorkers.ownerId, ownerId),
          isNull(schema.taskWorkers.deletedAt),
        ),
      );
    const row = (
      await this.database
        .insert(schema.taskWorkers)
        .values({
          id: randomUUID(),
          ownerId,
          name: input.name,
          enabled: input.enabled,
          modelId: rootModelId,
          reasoningEffort: input.modelConfiguration.reasoningEffort,
          customSubagentModel: input.modelConfiguration.customSubagentModel,
          subagentModelId: input.modelConfiguration.subagentModelId,
          subagentReasoningEffort:
            input.modelConfiguration.subagentReasoningEffort,
          maxConcurrency: input.maxConcurrency,
          allowsPlanGoal: input.allowsPlanGoal,
          continuityFamily:
            input.continuityFamilyOverride ??
            (await this.inferContinuityFamily(ownerId, rootModelId)),
          continuityFamilyOverride: input.continuityFamilyOverride,
          position: (positions[0]?.value ?? -1) + 1,
        })
        .returning()
    )[0]!;
    return toTaskWorkerSummary(row);
  }

  async updateTaskWorker(
    ownerId: string,
    taskWorkerId: string,
    input: TaskWorkerUpdate,
  ): Promise<TaskWorkerSummary | null> {
    const current = (
      await this.database
        .select()
        .from(schema.taskWorkers)
        .where(
          and(
            eq(schema.taskWorkers.id, taskWorkerId),
            eq(schema.taskWorkers.ownerId, ownerId),
            isNull(schema.taskWorkers.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!current) return null;
    if (current.rowVersion !== input.rowVersion) {
      throw new TaskSchedulingConflictError(
        "The Task Worker changed before this update was applied.",
        "stale-version",
      );
    }

    const configuration =
      input.modelConfiguration ?? modelConfiguration(current);
    const rootModelId = configuration.modelId;
    if (!rootModelId) {
      throw new TaskSchedulingConflictError(
        "A Task Worker root model must be selected.",
        "model-unavailable",
      );
    }
    await this.assertOwnedModels(ownerId, [
      rootModelId,
      ...(configuration.customSubagentModel && configuration.subagentModelId
        ? [configuration.subagentModelId]
        : []),
    ]);
    if (configuration.customSubagentModel && configuration.subagentModelId) {
      await this.assertCompatibleSubagentModel(
        ownerId,
        rootModelId,
        configuration.subagentModelId,
      );
    }

    const continuityFamilyOverride =
      input.continuityFamilyOverride !== undefined
        ? input.continuityFamilyOverride
        : current.continuityFamilyOverride;
    const continuityFamily = continuityFamilyOverride
      ? continuityFamilyOverride
      : input.modelConfiguration || input.continuityFamilyOverride === null
        ? await this.inferContinuityFamily(ownerId, rootModelId)
        : current.continuityFamily;
    const updated = (
      await this.database
        .update(schema.taskWorkers)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          modelId: rootModelId,
          reasoningEffort: configuration.reasoningEffort,
          customSubagentModel: configuration.customSubagentModel,
          subagentModelId: configuration.subagentModelId,
          subagentReasoningEffort: configuration.subagentReasoningEffort,
          ...(input.maxConcurrency !== undefined
            ? { maxConcurrency: input.maxConcurrency }
            : {}),
          ...(input.allowsPlanGoal !== undefined
            ? { allowsPlanGoal: input.allowsPlanGoal }
            : {}),
          continuityFamily,
          continuityFamilyOverride,
          rowVersion: sql`${schema.taskWorkers.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.taskWorkers.id, taskWorkerId),
            eq(schema.taskWorkers.ownerId, ownerId),
            eq(schema.taskWorkers.rowVersion, input.rowVersion),
            isNull(schema.taskWorkers.deletedAt),
          ),
        )
        .returning()
    )[0];
    if (!updated) {
      throw new TaskSchedulingConflictError(
        "The Task Worker changed before this update was applied.",
        "stale-version",
      );
    }
    return toTaskWorkerSummary(updated);
  }

  async deleteTaskWorker(
    ownerId: string,
    taskWorkerId: string,
    rowVersion: number,
  ): Promise<boolean> {
    const now = new Date();
    const deleted = await this.database
      .update(schema.taskWorkers)
      .set({
        enabled: false,
        deletedAt: now,
        rowVersion: sql`${schema.taskWorkers.rowVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.taskWorkers.id, taskWorkerId),
          eq(schema.taskWorkers.ownerId, ownerId),
          eq(schema.taskWorkers.rowVersion, rowVersion),
          isNull(schema.taskWorkers.deletedAt),
        ),
      )
      .returning({ id: schema.taskWorkers.id });
    if (deleted[0]) return true;
    const existing = await this.database
      .select({ rowVersion: schema.taskWorkers.rowVersion })
      .from(schema.taskWorkers)
      .where(
        and(
          eq(schema.taskWorkers.id, taskWorkerId),
          eq(schema.taskWorkers.ownerId, ownerId),
          isNull(schema.taskWorkers.deletedAt),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new TaskSchedulingConflictError(
        "The Task Worker changed before it was removed.",
        "stale-version",
      );
    }
    return false;
  }

  async reorderTaskWorkers(
    ownerId: string,
    input: TaskWorkerOrderUpdate,
  ): Promise<TaskWorkerSummary[]> {
    await this.database.transaction(async (transaction) => {
      const current = await transaction
        .select({ id: schema.taskWorkers.id })
        .from(schema.taskWorkers)
        .where(
          and(
            eq(schema.taskWorkers.ownerId, ownerId),
            isNull(schema.taskWorkers.deletedAt),
          ),
        );
      const currentIds = new Set(current.map(({ id }) => id));
      if (
        currentIds.size !== input.ids.length ||
        input.ids.some((id) => !currentIds.has(id))
      ) {
        throw new TaskSchedulingConflictError(
          "Task Worker ordering must include every current Task Worker once.",
          "invalid-order",
        );
      }
      await transaction
        .update(schema.taskWorkers)
        .set({
          position: sql`${schema.taskWorkers.position} + 1000000`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.taskWorkers.ownerId, ownerId),
            isNull(schema.taskWorkers.deletedAt),
          ),
        );
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.taskWorkers)
          .set({
            position,
            rowVersion: sql`${schema.taskWorkers.rowVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.taskWorkers.id, id),
              eq(schema.taskWorkers.ownerId, ownerId),
              isNull(schema.taskWorkers.deletedAt),
            ),
          );
      }
    });
    return this.listTaskWorkers(ownerId);
  }

  async getProjectTaskPauseState(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTaskPauseState | null> {
    const project = (
      await this.database
        .select({
          id: schema.projects.id,
          paused: schema.projects.taskSchedulingPaused,
          pausedAt: schema.projects.taskSchedulingPausedAt,
          rowVersion: schema.projects.taskSchedulingRevision,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1)
    )[0];
    return project
      ? projectTaskPauseStateSchema.parse({
          projectId: project.id,
          paused: project.paused,
          pausedAt: project.pausedAt ? iso(project.pausedAt) : null,
          rowVersion: project.rowVersion,
        })
      : null;
  }

  async setProjectTaskPauseState(
    ownerId: string,
    projectId: string,
    input: ProjectTaskPauseUpdate,
  ): Promise<ProjectTaskPauseState | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const owner = await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .for("update")
        .limit(1);
      if (!owner[0]) return null;
      const updated = (
        await transaction
          .update(schema.projects)
          .set({
            taskSchedulingPaused: input.paused,
            taskSchedulingPausedAt: input.paused ? now : null,
            taskSchedulingRevision: sql`${schema.projects.taskSchedulingRevision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
              eq(schema.projects.taskSchedulingRevision, input.rowVersion),
            ),
          )
          .returning({
            id: schema.projects.id,
            paused: schema.projects.taskSchedulingPaused,
            pausedAt: schema.projects.taskSchedulingPausedAt,
            rowVersion: schema.projects.taskSchedulingRevision,
          })
      )[0];
      if (!updated) {
        const exists = await transaction
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .limit(1);
        if (exists[0]) {
          throw new TaskSchedulingConflictError(
            "The Project Task pause state changed before this update was applied.",
            "stale-version",
          );
        }
        return null;
      }
      return projectTaskPauseStateSchema.parse({
        projectId: updated.id,
        paused: updated.paused,
        pausedAt: updated.pausedAt ? iso(updated.pausedAt) : null,
        rowVersion: updated.rowVersion,
      });
    });
  }
}
