import { randomUUID } from "node:crypto";

import type {
  ProjectWorktreeSummary,
  WorkerWorktreeSummary,
  WorktreeInventory,
} from "@cantrip/protocol";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import {
  toProjectWorktreeSummary,
  type ProjectWorktreeExecutionContext,
} from "./projects.js";
import { observedWorktreeLifecycle } from "./worktree-state.js";

export interface WorktreeRemovalBlockers {
  activeChatIds: string[];
  activeLeaseChatIds: string[];
  boundCodeTabIds: string[];
  runningTerminalIds: string[];
}

export interface WorktreeLifecycleRepositoryCollaborators {
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
  listProjectWorktrees(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[]>;
}

export class WorktreeLifecycleRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: WorktreeLifecycleRepositoryCollaborators,
  ) {}

  async reconcileProjectWorktrees(
    ownerId: string,
    projectId: string,
    workerId: string,
    inventory: WorktreeInventory,
    created?: {
      id: string;
      lifecycleState?: ProjectWorktreeSummary["lifecycleState"];
      name: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    },
  ): Promise<ProjectWorktreeSummary[] | null> {
    const ownedRows = await this.database
      .select({ source: schema.projectSources })
      .from(schema.projectSources)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectSources.workerId, workerId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    const source = ownedRows[0]?.source;
    if (!source) return null;
    if (source.sourceKind !== "git") {
      throw new Error(
        "Git worktree reconciliation is unavailable for folder sources.",
      );
    }
    const observedPrimaries = inventory.worktrees.filter(
      ({ isPrimary }) => isPrimary,
    );
    if (observedPrimaries.length !== 1) {
      throw new Error("Worker inventory did not contain exactly one Primary.");
    }
    const observedPrimary = observedPrimaries[0]!;
    // Protected repository paths are deliberately scoped by result field.
    // `source.absolutePath` and `observedPrimary.path` both originate from the
    // canonical `path` field, while `sourcePath` and `primaryPath` use distinct
    // routing handles even when they identify the same worker-local directory.
    if (source.absolutePath !== observedPrimary.path) {
      throw new Error("Worker inventory referred to a different replica path.");
    }
    if (
      source.repositoryFingerprint &&
      source.repositoryFingerprint !== inventory.repositoryFingerprint
    ) {
      throw new Error(
        "Worker inventory belongs to a different Git common directory.",
      );
    }

    await this.database.transaction(async (transaction) => {
      const observedAt = new Date();
      const existing = await transaction
        .select()
        .from(schema.projectWorktrees)
        .where(eq(schema.projectWorktrees.projectSourceId, source.id));
      const primary = existing.find((item) => item.isPrimary);
      if (!primary) {
        throw new Error("Project source has no Primary worktree.");
      }

      await transaction
        .update(schema.projectSources)
        .set({
          absolutePath: observedPrimary.path,
          repositoryFingerprint: inventory.repositoryFingerprint,
          updatedAt: observedAt,
        })
        .where(eq(schema.projectSources.id, source.id));

      const existingByPath = new Map(
        existing.map((item) => [item.absolutePath, item] as const),
      );
      const observedIds = new Set<string>();
      for (const observed of inventory.worktrees) {
        const matched = observed.isPrimary
          ? primary
          : existingByPath.get(observed.path);
        const id =
          matched?.id ??
          (created?.path === observed.path ? created.id : randomUUID());
        observedIds.add(id);
        const lifecycleState = observedWorktreeLifecycle(
          matched
            ? (matched.lifecycleState as ProjectWorktreeSummary["lifecycleState"])
            : created?.path === observed.path
              ? (created.lifecycleState ?? null)
              : null,
          observed,
        );
        const displayPath =
          matched?.displayPath ??
          (observed.isPrimary ? source.displayPath : observed.path);
        const values = {
          workerId: source.workerId,
          name:
            matched?.name ??
            (created?.path === observed.path
              ? created.name
              : (observed.branch ?? "External worktree")),
          absolutePath: observed.path,
          displayPath,
          isPrimary: observed.isPrimary,
          isDefault: matched?.isDefault ?? observed.isPrimary,
          origin:
            matched?.origin ??
            (created?.path === observed.path ? created.origin : "external"),
          lifecycleState,
          branch: observed.branch,
          head: observed.head,
          detached: observed.detached,
          locked: observed.locked,
          lockReason: observed.lockReason,
          lastScannedAt: observedAt,
          updatedAt: observedAt,
        };
        if (matched) {
          await transaction
            .update(schema.projectWorktrees)
            .set(values)
            .where(eq(schema.projectWorktrees.id, matched.id));
        } else {
          await transaction.insert(schema.projectWorktrees).values({
            id,
            projectSourceId: source.id,
            ...values,
          });
        }
      }

      for (const missing of existing) {
        if (!observedIds.has(missing.id) && !missing.isPrimary) {
          await transaction
            .update(schema.projectWorktrees)
            .set({
              lifecycleState: "missing",
              updatedAt: observedAt,
              lastScannedAt: observedAt,
            })
            .where(eq(schema.projectWorktrees.id, missing.id));
        }
      }
    });
    return this.collaborators.listProjectWorktrees(ownerId, projectId);
  }

  async rollbackProjectWorktreeCreation(
    ownerId: string,
    projectId: string,
    workerId: string,
    created: {
      id: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    },
  ): Promise<boolean> {
    if (created.origin !== "agent" && created.origin !== "cantrip") {
      return false;
    }
    const sources = await this.database
      .select({ id: schema.projectSources.id })
      .from(schema.projectSources)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectSources.workerId, workerId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    const sourceId = sources[0]?.id;
    if (!sourceId) return false;

    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.projectWorktrees)
        .where(eq(schema.projectWorktrees.id, created.id))
        .limit(1);
      const row = rows[0];
      if (!row) return true;
      if (
        row.projectSourceId !== sourceId ||
        row.workerId !== workerId ||
        row.absolutePath !== created.path ||
        row.isPrimary ||
        row.origin !== created.origin
      ) {
        return false;
      }
      const deleted = await transaction
        .delete(schema.projectWorktrees)
        .where(
          and(
            eq(schema.projectWorktrees.id, created.id),
            eq(schema.projectWorktrees.projectSourceId, sourceId),
            eq(schema.projectWorktrees.workerId, workerId),
            eq(schema.projectWorktrees.absolutePath, created.path),
            eq(schema.projectWorktrees.isPrimary, false),
            eq(schema.projectWorktrees.origin, created.origin),
          ),
        )
        .returning({ id: schema.projectWorktrees.id });
      return deleted.length === 1;
    });
  }

  async setProjectWorktreeLifecycle(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    lifecycleState: ProjectWorktreeSummary["lifecycleState"],
  ): Promise<ProjectWorktreeSummary | null> {
    const context = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({ lifecycleState, updatedAt: new Date() })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0] ? toProjectWorktreeSummary(rows[0], projectId) : null;
  }

  async observeProjectWorktree(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    observed: WorkerWorktreeSummary,
  ): Promise<ProjectWorktreeSummary | null> {
    const context = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    if (context.worktree.path !== observed.path) {
      throw new Error("Worker status referred to a different worktree path.");
    }
    const now = new Date();
    const lifecycleState = observedWorktreeLifecycle(
      context.worktree.lifecycleState,
      observed,
    );
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({
        branch: observed.branch,
        detached: observed.detached,
        head: observed.head,
        lifecycleState,
        locked: observed.locked,
        lockReason: observed.lockReason,
        lastScannedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0] ? toProjectWorktreeSummary(rows[0], projectId) : null;
  }

  async getWorktreeRemovalBlockers(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRemovalBlockers | null> {
    const context = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    const [chats, leases, terminals, codeTabs] = await Promise.all([
      this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.activeWorktreeId, worktreeId),
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
          ),
        ),
      this.database
        .select({ chatId: schema.chatExecutionLanes.chatId })
        .from(schema.chatExecutionLanes)
        .where(
          and(
            eq(schema.chatExecutionLanes.worktreeId, worktreeId),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        ),
      this.database
        .select({ id: schema.terminals.id })
        .from(schema.terminals)
        .where(
          and(
            eq(schema.terminals.worktreeId, worktreeId),
            eq(schema.terminals.status, "running"),
            ne(schema.terminals.kind, "run-configuration"),
          ),
        ),
      this.database
        .select({ id: schema.codeTabs.id })
        .from(schema.codeTabs)
        .where(eq(schema.codeTabs.worktreeId, worktreeId)),
    ]);
    return {
      activeChatIds: chats.map(({ id }) => id),
      activeLeaseChatIds: leases.map(({ chatId }) => chatId),
      boundCodeTabIds: codeTabs.map(({ id }) => id),
      runningTerminalIds: terminals.map(({ id }) => id),
    };
  }
}
