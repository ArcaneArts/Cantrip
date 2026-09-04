import type {
  EncryptedTerminalCreate,
  EncryptedTerminalServiceConfiguration,
  EncryptedTerminalUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ProjectWorktreeSummary,
  TerminalServiceRuntimeConfiguration,
  TerminalWireSummary,
  WorktreeSelection,
} from "@cantrip/protocol";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
} from "../tab-layouts.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import {
  requiredProjectChatProjectId,
  requiredProjectChatWorktreeId,
} from "./chat-execution-lanes.js";
import type { ProjectWorktreeExecutionContext } from "./projects.js";

export interface TerminalExecutionContext {
  kind: TerminalWireSummary["kind"];
  linkedChatId: string | null;
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  serviceEnabled: boolean;
  stateProtection: TerminalWireSummary["stateProtection"];
  status: TerminalWireSummary["status"];
  terminalId: string;
  workerId: string;
  worktreePath: string;
  worktreeId: string;
  runConfigurationId: string | null;
  runConfigurationRuntimeId: string | null;
}

export interface TerminalRepositoryCollaborators {
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
  getTerminalExecutionContext(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null>;
  nextProjectTabPosition(projectId: string): Promise<number>;
  resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit?: boolean,
  ): Promise<ExecutionPlacementResolution>;
  toTerminalWireSummary(
    terminal: typeof schema.terminals.$inferSelect,
  ): TerminalWireSummary;
}

export class TerminalRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: TerminalRepositoryCollaborators,
  ) {}

  async listTerminals(
    ownerId: string,
    projectId: string,
  ): Promise<TerminalWireSummary[]> {
    const rows = await this.database
      .select({ terminal: schema.terminals })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.terminals.projectId, projectId))
      .orderBy(asc(schema.terminals.position), asc(schema.terminals.createdAt));
    return rows.map(({ terminal }) =>
      this.collaborators.toTerminalWireSummary(terminal),
    );
  }

  async createTerminal(
    ownerId: string,
    projectId: string,
    input: EncryptedTerminalCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TerminalWireSummary | null> {
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
        "terminal",
        target,
        isWorkerConnected,
      );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;

    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.terminals)
        .values({
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          position,
          activeWorkerId: workerId,
          worktreeId,
        })
        .returning();
      const terminal = firstOrThrow(result, "creating a terminal");
      await attachProjectTab(transaction, {
        projectId,
        paneId: input.paneId ?? input.tabGroupId,
        tabId: terminal.id,
        tabKind: "terminal",
      });
      return this.collaborators.toTerminalWireSummary(terminal);
    });
  }

  async getOrCreateChatConsole(
    ownerId: string,
    chatId: string,
    input: Pick<
      EncryptedTerminalCreate,
      "id" | "titleProtection" | "stateProtection"
    >,
  ): Promise<TerminalWireSummary | null> {
    const rows = await this.database
      .select({ chat: schema.chats, worktree: schema.projectWorktrees })
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const projectId = requiredProjectChatProjectId(row.chat.projectId);
    const worktreeId = requiredProjectChatWorktreeId(row.chat.activeWorktreeId);

    const existing = await this.database
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.linkedChatId, chatId))
      .limit(1);
    if (existing[0])
      return this.collaborators.toTerminalWireSummary(existing[0]);

    const result = await this.database
      .insert(schema.terminals)
      .values({
        id: input.id,
        projectId,
        protectedLabel: input.titleProtection,
        protectedState: input.stateProtection,
        position: row.chat.position,
        status: "running",
        activeWorkerId: row.worktree.workerId,
        worktreeId,
        linkedChatId: row.chat.id,
        kind: "chat-console",
      })
      .returning();
    return this.collaborators.toTerminalWireSummary(
      firstOrThrow(result, "creating a chat console"),
    );
  }

  async updateTerminal(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalUpdate,
  ): Promise<TerminalWireSummary | null> {
    const owned = await this.collaborators.getTerminalExecutionContext(
      ownerId,
      terminalId,
    );
    if (!owned) return null;
    if (owned.kind === "run-configuration") {
      throw new Error(
        "Run configuration terminal titles come from their shared definition.",
      );
    }
    const result = await this.database
      .update(schema.terminals)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0]
      ? this.collaborators.toTerminalWireSummary(result[0])
      : null;
  }

  async updateTerminalService(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalServiceConfiguration,
  ): Promise<TerminalWireSummary | null> {
    const owned = await this.collaborators.getTerminalExecutionContext(
      ownerId,
      terminalId,
    );
    if (!owned) return null;
    if (owned.kind === "run-configuration") {
      throw new Error(
        "Run configuration terminals are controlled by their runtime.",
      );
    }
    if (owned.linkedChatId) {
      throw new Error("Linked Codex consoles cannot run terminal services.");
    }
    const result = await this.database
      .update(schema.terminals)
      .set({
        serviceEnabled: input.enabled,
        protectedState: input.stateProtection,
        updatedAt: new Date(),
      })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0]
      ? this.collaborators.toTerminalWireSummary(result[0])
      : null;
  }

  async listTerminalServicesForWorker(
    workerId: string,
    serverId: string,
  ): Promise<TerminalServiceRuntimeConfiguration[]> {
    const rows = await this.database
      .select({
        terminal: schema.terminals,
        worktree: schema.projectWorktrees,
      })
      .from(schema.terminals)
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
      )
      .where(
        and(
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.terminals.serviceEnabled, true),
        ),
      );
    return rows.map(({ terminal, worktree }) => {
      if (!terminal.protectedState) {
        throw new Error("Terminal service protection is unavailable.");
      }
      return {
        terminalId: terminal.id,
        serverId,
        worktreePath: worktree.absolutePath,
        stateProtection: terminal.protectedState,
      };
    });
  }

  async updateTerminalWorktree(
    ownerId: string,
    terminalId: string,
    input: WorktreeSelection,
  ): Promise<TerminalWireSummary | null> {
    const rows = await this.database
      .select({ terminal: schema.terminals })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.terminals.id, terminalId))
      .limit(1);
    const terminal = rows[0]?.terminal;
    if (!terminal) return null;
    if (terminal.kind === "run-configuration") {
      throw new Error("Run configuration terminals cannot change worktrees.");
    }
    if (terminal.linkedChatId) {
      throw new Error(
        "Linked Codex consoles inherit their parent chat worktree.",
      );
    }
    if (terminal.status === "running") {
      throw new Error("Stop the terminal before changing its worktree.");
    }
    const target = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      terminal.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const updated = await this.database
      .update(schema.terminals)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return updated[0]
      ? this.collaborators.toTerminalWireSummary(updated[0])
      : null;
  }

  async deleteTerminal(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    const context = await this.collaborators.getTerminalExecutionContext(
      ownerId,
      terminalId,
    );
    if (!context) return null;
    if (context.kind === "run-configuration") {
      const active = await this.database
        .select({ state: schema.runConfigurationRuntimes.state })
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.terminalId, terminalId),
            sql`${schema.runConfigurationRuntimes.state} IN ('starting', 'running', 'restarting', 'stopping')`,
          ),
        )
        .limit(1);
      if (active[0]) {
        throw new Error(
          "Stop the active Run configuration before closing its terminal.",
        );
      }
    }
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.runConfigurationRuntimes)
        .set({ terminalId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.terminalId, terminalId),
          ),
        );
      await detachProjectTab(
        transaction,
        context.projectId,
        projectTabKey("terminal", terminalId),
      );
      await transaction
        .delete(schema.terminals)
        .where(eq(schema.terminals.id, terminalId));
    });
    return context;
  }

  async getTerminalExecutionContext(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    const rows = await this.database
      .select({
        terminal: schema.terminals,
        worktree: schema.projectWorktrees,
      })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
      )
      .where(eq(schema.terminals.id, terminalId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          terminalId: row.terminal.id,
          projectId: row.terminal.projectId,
          kind: row.terminal.kind,
          rootKind: row.worktree.rootKind,
          workerId: row.terminal.activeWorkerId,
          worktreeId: row.worktree.id,
          worktreePath: row.worktree.absolutePath,
          linkedChatId: row.terminal.linkedChatId,
          runConfigurationId: row.terminal.runConfigurationId,
          runConfigurationRuntimeId: row.terminal.runConfigurationRuntimeId,
          serviceEnabled: row.terminal.serviceEnabled,
          stateProtection: row.terminal.protectedState,
          status: row.terminal.status as TerminalWireSummary["status"],
        }
      : null;
  }

  async setTerminalStatus(
    terminalId: string,
    status: TerminalWireSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.terminals)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId));
  }
}
