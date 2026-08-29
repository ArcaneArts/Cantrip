import type {
  EncryptedExplorerCreate,
  EncryptedExplorerPin,
  EncryptedExplorerUpdate,
  EncryptedExplorerViewStateUpdate,
  EncryptedExplorerWorktreeUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ExplorerWireSummary,
} from "@cantrip/protocol";
import { and, asc, eq } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
} from "../tab-layouts.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import type { ProjectWorktreeExecutionContext } from "./projects.js";

export interface ExplorerExecutionContext {
  explorerId: string;
  projectId: string;
  root: string;
  workerId: string;
  worktreeId: string;
}

export interface ExplorerRepositoryCollaborators {
  getExplorerExecutionContext(
    ownerId: string,
    explorerId: string,
  ): Promise<ExplorerExecutionContext | null>;
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
  nextProjectTabPosition(projectId: string): Promise<number>;
  resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit?: boolean,
  ): Promise<ExecutionPlacementResolution>;
  toExplorerWireSummary(
    explorer: typeof schema.explorers.$inferSelect,
  ): ExplorerWireSummary;
}

export class ExplorerRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ExplorerRepositoryCollaborators,
  ) {}

  async listExplorers(
    ownerId: string,
    projectId: string,
  ): Promise<ExplorerWireSummary[]> {
    const rows = await this.database
      .select({ explorer: schema.explorers })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.explorers.projectId, projectId))
      .orderBy(asc(schema.explorers.position), asc(schema.explorers.createdAt));
    return rows.map(({ explorer }) =>
      this.collaborators.toExplorerWireSummary(explorer),
    );
  }

  async createExplorer(
    ownerId: string,
    projectId: string,
    input: EncryptedExplorerCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExplorerWireSummary | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } =
      await this.collaborators.resolveProjectExecutionPlacement(
        ownerId,
        projectId,
        "explorer",
        target,
        isWorkerConnected,
      );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;
    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.explorers)
        .values({
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          position,
          activeWorkerId: workerId,
          worktreeId,
          fileMode: input.fileMode ?? "preview",
        })
        .returning();
      const explorer = firstOrThrow(result, "creating an explorer");
      if (input.attachToTabLayout !== false) {
        await attachProjectTab(transaction, {
          projectId,
          tabGroupId: input.tabGroupId,
          tabId: explorer.id,
          tabKind: "explorer",
        });
      }
      return this.collaborators.toExplorerWireSummary(explorer);
    });
  }

  async updateExplorerWorktree(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerWorktreeUpdate,
  ): Promise<ExplorerWireSummary | null> {
    const rows = await this.database
      .select({ explorer: schema.explorers })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.explorers.id, explorerId))
      .limit(1);
    const explorer = rows[0]?.explorer;
    if (!explorer) return null;
    const target = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      explorer.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const updated = await this.database
      .update(schema.explorers)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        protectedState: input.stateProtection,
        fileMode: "preview",
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return updated[0]
      ? this.collaborators.toExplorerWireSummary(updated[0])
      : null;
  }

  async getExplorerExecutionContext(
    ownerId: string,
    explorerId: string,
  ): Promise<ExplorerExecutionContext | null> {
    const rows = await this.database
      .select({
        explorer: schema.explorers,
        worktree: schema.projectWorktrees,
      })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.explorers.worktreeId),
      )
      .where(eq(schema.explorers.id, explorerId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          explorerId: row.explorer.id,
          projectId: row.explorer.projectId,
          root: row.worktree.absolutePath,
          workerId: row.explorer.activeWorkerId,
          worktreeId: row.worktree.id,
        }
      : null;
  }

  async updateExplorer(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerUpdate,
  ): Promise<ExplorerWireSummary | null> {
    if (
      !(await this.collaborators.getExplorerExecutionContext(
        ownerId,
        explorerId,
      ))
    )
      return null;
    const result = await this.database
      .update(schema.explorers)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0]
      ? this.collaborators.toExplorerWireSummary(result[0])
      : null;
  }

  async pinExplorer(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerPin,
  ): Promise<ExplorerWireSummary | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ explorer: schema.explorers })
        .from(schema.explorers)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.explorers.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.explorers.id, explorerId))
        .limit(1)
        .for("update");
      const explorer = rows[0]?.explorer;
      if (!explorer) return null;

      const tabKey = projectTabKey("explorer", explorerId);
      const existingMembers = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(
          and(
            eq(schema.tabGroupMembers.projectId, explorer.projectId),
            eq(schema.tabGroupMembers.tabKey, tabKey),
          ),
        )
        .limit(1);
      if (existingMembers[0]) {
        // The operation is retry-safe, but it must never repurpose an
        // Explorer that is already a tab.
        return this.collaborators.toExplorerWireSummary(explorer);
      }

      const updatedRows = await transaction
        .update(schema.explorers)
        .set({
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          fileMode: input.fileMode,
          updatedAt: new Date(),
        })
        .where(eq(schema.explorers.id, explorerId))
        .returning();
      const updated = firstOrThrow(updatedRows, "pinning an explorer");
      await attachProjectTab(transaction, {
        projectId: explorer.projectId,
        tabGroupId: input.tabGroupId,
        tabId: explorerId,
        tabKind: "explorer",
      });

      return this.collaborators.toExplorerWireSummary(updated);
    });
  }

  async updateExplorerViewState(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerViewStateUpdate,
  ): Promise<ExplorerWireSummary | null> {
    if (
      !(await this.collaborators.getExplorerExecutionContext(
        ownerId,
        explorerId,
      ))
    ) {
      return null;
    }
    const result = await this.database
      .update(schema.explorers)
      .set({
        protectedState: input.stateProtection,
        fileMode: input.fileMode,
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0]
      ? this.collaborators.toExplorerWireSummary(result[0])
      : null;
  }

  async deleteExplorer(ownerId: string, explorerId: string): Promise<boolean> {
    const context = await this.collaborators.getExplorerExecutionContext(
      ownerId,
      explorerId,
    );
    if (!context) return false;
    return this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.projectId,
        projectTabKey("explorer", explorerId),
      );
      const result = await transaction
        .delete(schema.explorers)
        .where(eq(schema.explorers.id, explorerId))
        .returning({ id: schema.explorers.id });
      return result.length === 1;
    });
  }
}
