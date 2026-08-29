import { randomUUID } from "node:crypto";

import type {
  CodeCapabilities,
  CodeEditorBuild,
  CodeRuntimeStatus,
  CodeSessionSummary,
  CodeTabWireSummary,
  EncryptedCodeTabCreate,
  EncryptedCodeTabUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  WorktreeSelection,
} from "@cantrip/protocol";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";

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

export class CodeCapabilityUnavailableError extends Error {}
class StaleCodeSessionRuntimeError extends Error {}

export interface CodeTabExecutionContext {
  capabilities: CodeCapabilities;
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
    profileId: codeTab.profileId,
    themeMode: codeTab.themeMode as CodeTabWireSummary["themeMode"],
    status: codeTab.status as CodeTabWireSummary["status"],
    lastError: codeTab.lastError,
    createdAt: toISOString(codeTab.createdAt),
    updatedAt: toISOString(codeTab.updatedAt),
  };
}

function toCodeSessionSummary(
  session: typeof schema.codeSessions.$inferSelect,
): CodeSessionSummary {
  return {
    id: session.id,
    codeTabId: session.codeTabId,
    projectId: session.projectId,
    workerId: session.workerId,
    worktreeId: session.worktreeId,
    profileId: session.profileId,
    editorBuild: {
      version: session.editorVersion,
      upstreamRevision: session.editorUpstreamRevision,
      patchset: session.editorPatchset,
      fingerprint: session.editorFingerprint,
    },
    status: session.status as CodeSessionSummary["status"],
    processInstanceId: session.processInstanceId,
    lastAttachmentAt: session.lastAttachmentAt
      ? toISOString(session.lastAttachmentAt)
      : null,
    lastStartedAt: session.lastStartedAt
      ? toISOString(session.lastStartedAt)
      : null,
    stoppedAt: session.stoppedAt ? toISOString(session.stoppedAt) : null,
    lastError: session.lastError,
    createdAt: toISOString(session.createdAt),
    updatedAt: toISOString(session.updatedAt),
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
        "code",
        target,
        isWorkerConnected,
      );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;
    const workerRows = await this.database
      .select({ codeCapabilities: schema.workers.codeCapabilities })
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .limit(1);
    const capabilities = workerRows[0]?.codeCapabilities;
    if (!capabilities?.available) {
      throw new CodeCapabilityUnavailableError(
        capabilities?.reason ?? "Cantrip Code is unavailable on this worker.",
      );
    }
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
          profileId: input.profileId,
          themeMode: input.themeMode,
        })
        .returning();
      const codeTab = firstOrThrow(result, "creating a Code tab");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
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
        codeCapabilities: schema.workers.codeCapabilities,
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
          capabilities: row.codeCapabilities,
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
        ...(input.themeMode ? { themeMode: input.themeMode } : {}),
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
    if (
      context.codeTab.status === "starting" ||
      context.codeTab.status === "running"
    ) {
      throw new Error("Stop Cantrip Code before changing its worktree.");
    }
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
        status: "idle",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.codeTabs.id, codeTabId),
          eq(schema.codeTabs.activeWorkerId, context.workerId),
          eq(schema.codeTabs.worktreeId, context.worktreeId),
          eq(schema.codeTabs.profileId, context.codeTab.profileId),
          notInArray(schema.codeTabs.status, ["starting", "running"]),
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

  async listCodeSessions(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeSessionSummary[] | null> {
    if (
      !(await this.collaborators.getCodeTabExecutionContext(ownerId, codeTabId))
    ) {
      return null;
    }
    const rows = await this.database
      .select()
      .from(schema.codeSessions)
      .where(eq(schema.codeSessions.codeTabId, codeTabId))
      .orderBy(
        desc(schema.codeSessions.updatedAt),
        desc(schema.codeSessions.createdAt),
      );
    return rows.map(toCodeSessionSummary);
  }

  async getOrCreateCodeSession(
    ownerId: string,
    codeTabId: string,
    editorBuild: CodeEditorBuild,
    preferredSessionId: string = randomUUID(),
  ): Promise<CodeSessionSummary | null> {
    const context = await this.collaborators.getCodeTabExecutionContext(
      ownerId,
      codeTabId,
    );
    if (!context) return null;
    const existing = await this.database
      .select()
      .from(schema.codeSessions)
      .where(
        and(
          eq(schema.codeSessions.codeTabId, codeTabId),
          eq(schema.codeSessions.workerId, context.workerId),
          eq(schema.codeSessions.worktreeId, context.worktreeId),
          eq(schema.codeSessions.profileId, context.codeTab.profileId),
          eq(schema.codeSessions.editorFingerprint, editorBuild.fingerprint),
        ),
      )
      .limit(1);
    if (existing[0]) return toCodeSessionSummary(existing[0]);
    const inserted = await this.database
      .insert(schema.codeSessions)
      .values({
        id: preferredSessionId,
        codeTabId,
        projectId: context.codeTab.projectId,
        workerId: context.workerId,
        worktreeId: context.worktreeId,
        profileId: context.codeTab.profileId,
        editorVersion: editorBuild.version,
        editorUpstreamRevision: editorBuild.upstreamRevision,
        editorPatchset: editorBuild.patchset,
        editorFingerprint: editorBuild.fingerprint,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return toCodeSessionSummary(inserted[0]);
    const raced = await this.database
      .select()
      .from(schema.codeSessions)
      .where(
        and(
          eq(schema.codeSessions.codeTabId, codeTabId),
          eq(schema.codeSessions.workerId, context.workerId),
          eq(schema.codeSessions.worktreeId, context.worktreeId),
          eq(schema.codeSessions.profileId, context.codeTab.profileId),
          eq(schema.codeSessions.editorFingerprint, editorBuild.fingerprint),
        ),
      )
      .limit(1);
    return raced[0] ? toCodeSessionSummary(raced[0]) : null;
  }

  async updateCodeSessionRuntime(
    ownerId: string,
    codeTabId: string,
    sessionId: string,
    runtime: CodeRuntimeStatus,
    attached = false,
  ): Promise<CodeSessionSummary | null> {
    const context = await this.collaborators.getCodeTabExecutionContext(
      ownerId,
      codeTabId,
    );
    if (!context || runtime.sessionId !== sessionId) return null;
    const tabStatus: CodeTabWireSummary["status"] =
      runtime.status === "starting"
        ? "starting"
        : runtime.status === "running" || runtime.status === "idle"
          ? "running"
          : runtime.status === "offline"
            ? "offline"
            : runtime.status === "failed"
              ? "failed"
              : "stopped";
    try {
      return await this.database.transaction(async (transaction) => {
        const rows = await transaction
          .update(schema.codeSessions)
          .set({
            status: runtime.status,
            processInstanceId: runtime.processInstanceId,
            ...(attached ? { lastAttachmentAt: new Date() } : {}),
            ...(runtime.startedAt
              ? { lastStartedAt: new Date(runtime.startedAt) }
              : {}),
            stoppedAt: runtime.status === "stopped" ? new Date() : null,
            lastError: runtime.lastError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.codeSessions.id, sessionId),
              eq(schema.codeSessions.codeTabId, codeTabId),
              eq(schema.codeSessions.workerId, context.workerId),
              eq(schema.codeSessions.worktreeId, context.worktreeId),
              eq(schema.codeSessions.profileId, context.codeTab.profileId),
              eq(
                schema.codeSessions.editorFingerprint,
                runtime.editorBuild.fingerprint,
              ),
            ),
          )
          .returning();
        const session = rows[0];
        if (!session) return null;
        const tabs = await transaction
          .update(schema.codeTabs)
          .set({
            status: tabStatus,
            lastError: runtime.lastError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.codeTabs.id, codeTabId),
              eq(schema.codeTabs.activeWorkerId, context.workerId),
              eq(schema.codeTabs.worktreeId, context.worktreeId),
              eq(schema.codeTabs.profileId, context.codeTab.profileId),
            ),
          )
          .returning({ id: schema.codeTabs.id });
        if (!tabs[0]) throw new StaleCodeSessionRuntimeError();
        return toCodeSessionSummary(session);
      });
    } catch (error) {
      if (error instanceof StaleCodeSessionRuntimeError) return null;
      throw error;
    }
  }
}
