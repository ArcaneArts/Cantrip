import { randomUUID } from "node:crypto";

import type {
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  ProjectWorktreeSummary,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import {
  toProjectWorktreeSummary,
  type ProjectWorktreeExecutionContext,
} from "./projects.js";

type GitOperationRow = typeof schema.gitOperations.$inferSelect;

export interface ProjectWorktreeObservationContext {
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  sourcePath: string;
  workerId: string;
  worktreeId: string;
  worktreePath: string;
}

export interface ProjectWorktreeStatusRecord {
  metadataChanged: boolean;
  snapshotChanged: boolean;
  status: WorktreeStatusResult;
  worktree: ProjectWorktreeSummary;
}

export interface WorktreeStateRepositoryCollaborators {
  getActiveGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null>;
  getGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
  ): Promise<GitManagedOperationRecord | null>;
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
}

export function observedWorktreeLifecycle(
  _current: ProjectWorktreeSummary["lifecycleState"] | null,
  observed: { missing: boolean; prunable: boolean },
): ProjectWorktreeSummary["lifecycleState"] {
  if (observed.missing) return "missing";
  if (observed.prunable) return "prunable";
  return "ready";
}

function toGitManagedOperationRecord(
  operation: GitOperationRow,
): GitManagedOperationRecord {
  return {
    id: operation.id,
    projectId: operation.projectId,
    worktreeId: operation.worktreeId,
    workerId: operation.workerId,
    type: operation.type,
    state: operation.state,
    originalHead: operation.originalHead,
    currentHead: operation.currentHead,
    sourceRef: operation.sourceRef,
    sourceRevision: operation.sourceRevision,
    targetRef: operation.targetRef,
    targetRevision: operation.targetRevision,
    pendingCommits: operation.pendingCommits,
    currentStep: operation.currentStep,
    totalSteps: operation.totalSteps,
    conflictedPaths: operation.conflictedPaths,
    output: operation.output,
    checkpointRef: operation.checkpointRef,
    pausedAction: operation.pausedAction,
    error: operation.error,
    createdAt: toISOString(operation.createdAt),
    updatedAt: toISOString(operation.updatedAt),
    completedAt: operation.completedAt
      ? toISOString(operation.completedAt)
      : null,
  };
}

export class WorktreeStateRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: WorktreeStateRepositoryCollaborators,
  ) {}

  async listProjectWorktrees(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[]> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        worktree: schema.projectWorktrees,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
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
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        desc(schema.projectWorktrees.isPrimary),
        asc(schema.projectWorktrees.name),
      );
    return rows.map(({ projectId: id, worktree }) =>
      toProjectWorktreeSummary(worktree, id),
    );
  }

  async listWorkerWorktreeObservationTargets(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectSources.sourceKind, "git"),
          eq(schema.projectWorktrees.rootKind, "git-worktree"),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(asc(schema.projectWorktrees.createdAt))
      .limit(Math.min(128, Math.max(1, limit)));
  }

  async listWorkerExecutionRootContexts(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(asc(schema.projectWorktrees.createdAt))
      .limit(Math.min(128, Math.max(1, limit)));
  }

  async getProjectWorktreeObservationContext(
    ownerId: string,
    workerId: string,
    sourcePath: string,
    worktreePath: string,
  ): Promise<ProjectWorktreeObservationContext | null> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectSources.sourceKind, "git"),
          eq(schema.projectWorktrees.rootKind, "git-worktree"),
          eq(schema.projectSources.absolutePath, sourcePath),
          eq(schema.projectWorktrees.absolutePath, worktreePath),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getProjectWorktreeStatusSnapshot(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeStatusResult | null> {
    const rows = await this.database
      .select({ status: schema.projectWorktrees.statusSnapshot })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
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
          eq(schema.projectWorktrees.id, worktreeId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    return rows[0]?.status ?? null;
  }

  async recordProjectWorktreeStatus(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ): Promise<ProjectWorktreeStatusRecord | null> {
    const context = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    if (context.worktree.path !== status.worktree.path) {
      throw new Error("Worker status referred to a different worktree path.");
    }
    const currentRows = await this.database
      .select()
      .from(schema.projectWorktrees)
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .limit(1);
    const current = currentRows[0];
    if (!current) return null;
    const lifecycleState = observedWorktreeLifecycle(
      current.lifecycleState as ProjectWorktreeSummary["lifecycleState"],
      status.worktree,
    );
    const metadataChanged =
      current.branch !== status.worktree.branch ||
      current.detached !== status.worktree.detached ||
      current.head !== status.worktree.head ||
      current.lifecycleState !== lifecycleState ||
      current.locked !== status.worktree.locked ||
      current.lockReason !== status.worktree.lockReason;
    const snapshotChanged =
      JSON.stringify(current.statusSnapshot) !== JSON.stringify(status);
    if (!metadataChanged && !snapshotChanged) {
      return {
        metadataChanged,
        snapshotChanged,
        status,
        worktree: context.worktree,
      };
    }
    const now = new Date();
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({
        branch: status.worktree.branch,
        detached: status.worktree.detached,
        head: status.worktree.head,
        lifecycleState,
        locked: status.worktree.locked,
        lockReason: status.worktree.lockReason,
        lastScannedAt: now,
        statusObservedAt: now,
        statusSnapshot: status,
        updatedAt: now,
      })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0]
      ? {
          metadataChanged,
          snapshotChanged,
          status,
          worktree: toProjectWorktreeSummary(rows[0], projectId),
        }
      : null;
  }

  async createGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    workerId: string,
    context: GitManagedOperationContext,
  ): Promise<GitManagedOperationRecord> {
    const existing = await this.collaborators.getActiveGitOperation(
      ownerId,
      projectId,
      worktreeId,
    );
    if (existing) {
      throw new Error(
        `This worktree already has an active ${existing.type} operation.`,
      );
    }
    const rows = await this.database
      .insert(schema.gitOperations)
      .values({
        id: randomUUID(),
        ownerId,
        projectId,
        worktreeId,
        workerId,
        type: context.type,
        state: "queued",
        originalHead: context.originalHead,
        currentHead: context.originalHead,
        sourceRef: context.sourceRef,
        sourceRevision: context.sourceRevision,
        targetRef: context.targetRef,
        targetRevision: context.targetRevision,
        pendingCommits: context.pendingCommits,
        currentStep: 0,
        totalSteps: context.totalSteps,
        conflictedPaths: [],
        output: "",
        checkpointRef: context.checkpointRef,
        pausedAction: null,
      })
      .returning();
    return toGitManagedOperationRecord(
      firstOrThrow(rows, "creating Git operation"),
    );
  }

  async getActiveGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
          inArray(schema.gitOperations.state, [
            "queued",
            "running",
            "conflicted",
            "awaiting-user-action",
          ]),
        ),
      )
      .orderBy(desc(schema.gitOperations.updatedAt))
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async markGitOperationRunning(
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .update(schema.gitOperations)
      .set({ state: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.gitOperations.id, operationId),
          eq(schema.gitOperations.state, "queued"),
        ),
      )
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }

  async getGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.id, operationId),
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
        ),
      )
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async getLatestGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
        ),
      )
      .orderBy(desc(schema.gitOperations.updatedAt))
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async updateGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    state: GitManagedOperationWorkerState,
  ): Promise<GitManagedOperationRecord | null> {
    const current = await this.collaborators.getGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
    );
    if (!current) return null;
    if (
      current.type !== state.type ||
      current.originalHead !== state.originalHead ||
      current.sourceRef !== state.sourceRef ||
      current.sourceRevision !== state.sourceRevision ||
      current.targetRef !== state.targetRef ||
      current.targetRevision !== state.targetRevision ||
      current.checkpointRef !== state.checkpointRef
    ) {
      throw new Error(
        "Worker operation state does not match its durable record.",
      );
    }
    const terminal = ["completed", "failed", "aborted"].includes(state.state);
    const output = [current.output, state.output]
      .filter(Boolean)
      .join("\n")
      .slice(-1_000_000);
    const rows = await this.database
      .update(schema.gitOperations)
      .set({
        state: state.state,
        currentHead: state.currentHead,
        pendingCommits: state.pendingCommits,
        currentStep: state.currentStep,
        totalSteps: state.totalSteps,
        conflictedPaths: state.conflictedPaths,
        output,
        pausedAction: state.pausedAction ?? null,
        error: null,
        completedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.gitOperations.id, operationId))
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }

  async failGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    error: string,
  ): Promise<GitManagedOperationRecord | null> {
    const current = await this.collaborators.getGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
    );
    if (!current) return null;
    const rows = await this.database
      .update(schema.gitOperations)
      .set({
        state: "failed",
        error: error.slice(0, 1_000_000),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.gitOperations.id, operationId))
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }
}
