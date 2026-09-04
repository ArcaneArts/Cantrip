import type {
  EncryptedProjectViewCreate,
  EncryptedProjectViewUpdate,
  ProjectViewWireSummary,
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

export interface ProjectViewRepositoryCollaborators {
  getProjectSource(
    ownerId: string,
    projectId: string,
  ): Promise<{ worktreeId: string } | null>;
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
  nextProjectTabPosition(projectId: string): Promise<number>;
}

function toProjectViewWireSummary(
  view: typeof schema.projectViews.$inferSelect,
): ProjectViewWireSummary {
  return {
    id: view.id,
    projectId: view.projectId,
    titleProtection: view.protectedLabel,
    kind: view.kind as ProjectViewWireSummary["kind"],
    worktreeId: view.worktreeId,
    position: view.position,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(view.updatedAt),
  };
}

export class ProjectViewRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ProjectViewRepositoryCollaborators,
  ) {}

  async listProjectViews(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectViewWireSummary[]> {
    const rows = await this.database
      .select({ view: schema.projectViews })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.projectId, projectId))
      .orderBy(
        asc(schema.projectViews.position),
        asc(schema.projectViews.createdAt),
      );
    return rows.map(({ view }) => toProjectViewWireSummary(view));
  }

  async getProjectViewProjectId(
    ownerId: string,
    viewId: string,
  ): Promise<string | null> {
    const rows = await this.database
      .select({ projectId: schema.projectViews.projectId })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  async createProjectView(
    ownerId: string,
    projectId: string,
    input: EncryptedProjectViewCreate,
  ): Promise<ProjectViewWireSummary | null> {
    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.projectViews)
        .values({
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          kind: input.kind,
          worktreeId: null,
          position,
        })
        .returning();
      const view = firstOrThrow(result, "creating a project view");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: view.id,
        tabKind: input.kind,
      });
      return toProjectViewWireSummary(view);
    });
  }

  async updateProjectView(
    ownerId: string,
    viewId: string,
    input: EncryptedProjectViewUpdate,
  ): Promise<ProjectViewWireSummary | null> {
    if (!(await this.projectViewIsOwnedBy(ownerId, viewId))) return null;
    const result = await this.database
      .update(schema.projectViews)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.projectViews.id, viewId))
      .returning();
    return result[0] ? toProjectViewWireSummary(result[0]) : null;
  }

  async updateProjectViewWorktree(
    ownerId: string,
    viewId: string,
    input: WorktreeSelection,
  ): Promise<ProjectViewWireSummary | null> {
    const rows = await this.database
      .select({ view: schema.projectViews })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    const view = rows[0]?.view;
    if (!view) return null;
    void input;
    throw new Error("This project view does not use worktrees.");
  }

  async deleteProjectView(ownerId: string, viewId: string): Promise<boolean> {
    const rows = await this.database
      .select({ view: schema.projectViews })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    const view = rows[0]?.view;
    if (!view) return false;
    const result = await this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        view.projectId,
        projectTabKey(view.kind as ProjectViewWireSummary["kind"], viewId),
      );
      await transaction
        .delete(schema.remoteSurfaces)
        .where(eq(schema.remoteSurfaces.id, viewId));
      return transaction
        .delete(schema.projectViews)
        .where(eq(schema.projectViews.id, viewId))
        .returning({ id: schema.projectViews.id });
    });
    return result.length === 1;
  }

  private async projectViewIsOwnedBy(
    ownerId: string,
    viewId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projectViews.id })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    return rows.length === 1;
  }
}
