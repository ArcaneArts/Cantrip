import type {
  CodeTabWireSummary,
  EncryptedCodeTabCreate,
  EncryptedCodeTabUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  WorktreeSelection,
} from "@cantrip/protocol";
import { and, asc, eq } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
} from "../tab-layouts.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import type { ProjectWorktreeExecutionContext } from "./projects.js";

export interface CodeTabExecutionContext {
  codeTab: CodeTabWireSummary;
  cwd: string;
  workerId: string;
  worktreeId: string;
  worktreeName: string;
}

export interface CodeSurfaceRepositoryCollaborators {
  getCodeTabExecutionContext(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null>;
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
}

function toCodeTabWireSummary(
  codeTab: typeof schema.codeTabs.$inferSelect,
): CodeTabWireSummary {
  return {
    id: codeTab.id,
    projectId: codeTab.projectId,
    titleProtection: codeTab.protectedLabel,
    position: codeTab.position,
    activeWorkerId: codeTab.activeWorkerId,
    worktreeId: codeTab.worktreeId,
    createdAt: toISOString(codeTab.createdAt),
    updatedAt: toISOString(codeTab.updatedAt),
  };
}

export class CodeSurfaceRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: CodeSurfaceRepositoryCollaborators,
  ) {}

  async listCodeTabs(
    ownerId: string,
    projectId: string,
  ): Promise<CodeTabWireSummary[]> {
    const rows = await this.database
      .select({ codeTab: schema.codeTabs })
      .from(schema.codeTabs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.codeTabs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.codeTabs.projectId, projectId))
      .orderBy(asc(schema.codeTabs.position), asc(schema.codeTabs.createdAt));
    return rows.map(({ codeTab }) => toCodeTabWireSummary(codeTab));
  }

  async createCodeTab(
    ownerId: string,
    projectId: string,
    input: EncryptedCodeTabCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<CodeTabWireSummary | null> {
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
        .insert(schema.codeTabs)
        .values({
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          position,
          activeWorkerId: workerId,
          worktreeId,
        })
        .returning();
      const codeTab = firstOrThrow(result, "creating a Code tab");
      await attachProjectTab(transaction, {
        projectId,
        paneId: input.paneId ?? input.tabGroupId,
        region: input.targetRegion,
        tabId: codeTab.id,
        tabKind: "code",
      });
      return toCodeTabWireSummary(codeTab);
    });
  }

  async getCodeTabExecutionContext(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    const rows = await this.database
      .select({
        codeTab: schema.codeTabs,
        worktree: schema.projectWorktrees,
      })
      .from(schema.codeTabs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.codeTabs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.codeTabs.worktreeId),
      )
      .innerJoin(
        schema.workers,
        eq(schema.workers.id, schema.codeTabs.activeWorkerId),
      )
      .where(eq(schema.codeTabs.id, codeTabId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          codeTab: toCodeTabWireSummary(row.codeTab),
          cwd: row.worktree.absolutePath,
          workerId: row.codeTab.activeWorkerId,
          worktreeId: row.worktree.id,
          worktreeName: row.worktree.name,
        }
      : null;
  }

  async updateCodeTab(
    ownerId: string,
    codeTabId: string,
    input: EncryptedCodeTabUpdate,
  ): Promise<CodeTabWireSummary | null> {
    if (
      !(await this.collaborators.getCodeTabExecutionContext(ownerId, codeTabId))
    ) {
      return null;
    }
    const result = await this.database
      .update(schema.codeTabs)
      .set({
        ...(input.titleProtection
          ? { protectedLabel: input.titleProtection }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.codeTabs.id, codeTabId))
      .returning();
    return result[0] ? toCodeTabWireSummary(result[0]) : null;
  }

  async updateCodeTabWorktree(
    ownerId: string,
    codeTabId: string,
    input: WorktreeSelection,
  ): Promise<CodeTabWireSummary | null> {
    const context = await this.collaborators.getCodeTabExecutionContext(
      ownerId,
      codeTabId,
    );
    if (!context) return null;
    const target = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      context.codeTab.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const result = await this.database
      .update(schema.codeTabs)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.codeTabs.id, codeTabId),
          eq(schema.codeTabs.activeWorkerId, context.workerId),
          eq(schema.codeTabs.worktreeId, context.worktreeId),
        ),
      )
      .returning();
    return result[0] ? toCodeTabWireSummary(result[0]) : null;
  }

  async deleteCodeTab(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    const context = await this.collaborators.getCodeTabExecutionContext(
      ownerId,
      codeTabId,
    );
    if (!context) return null;
    await this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.codeTab.projectId,
        projectTabKey("code", codeTabId),
      );
      await transaction
        .delete(schema.codeTabs)
        .where(eq(schema.codeTabs.id, codeTabId));
    });
    return context;
  }
}
