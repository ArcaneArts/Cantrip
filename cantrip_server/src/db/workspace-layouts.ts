import { isDeepStrictEqual } from "node:util";
import {
  applyWorkspaceCommand,
  PROJECT_SURFACE_DEFINITIONS,
  seedWorkspaceOwnership,
  WorkspaceCommandError,
  workspaceCommandSchema,
  workspaceOwnershipSchema,
  type WorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import * as schema from "./schema.js";
import {
  ProjectTabLayoutRepository,
  resolveEntitySurface,
} from "./tab-layouts.js";

function scope(ownerId: string, projectId: string, workspaceId: string) {
  return and(
    eq(schema.workspaceLayouts.ownerId, ownerId),
    eq(schema.workspaceLayouts.projectId, projectId),
    eq(schema.workspaceLayouts.workspaceId, workspaceId),
  );
}

/** Locks actual project authority, not an inferred client capability. */
async function ownedProject(
  tx: RepositoryTransaction,
  ownerId: string,
  projectId: string,
) {
  const rows = await tx
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.ownerId, ownerId),
      ),
    )
    .for("share");
  return rows.length !== 0;
}

function validatePlacements(layout: WorkspaceOwnership) {
  for (const window of layout.windows)
    for (const pane of window.panes)
      for (const tab of pane.tabs) {
        const definition = PROJECT_SURFACE_DEFINITIONS.find(
          (d) => d.id === tab.resource.definitionId,
        );
        if (
          !definition?.supportedPlacements.includes(pane.region) ||
          definition.id === "project.overview"
        ) {
          throw new WorkspaceCommandError(
            "invalid",
            "The surface does not support this pane placement.",
          );
        }
      }
}

/** Durable device-workspace state. Legacy APIs never write these records. */
export class WorkspaceLayoutRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async get(ownerId: string, projectId: string, workspaceId: string) {
    return this.database.transaction(async (tx) => {
      if (!(await ownedProject(tx, ownerId, projectId))) return null;
      const [row] = await tx
        .select()
        .from(schema.workspaceLayouts)
        .where(scope(ownerId, projectId, workspaceId));
      return row ? workspaceOwnershipSchema.parse(row.layout) : null;
    });
  }

  async seed(
    ownerId: string,
    projectId: string,
    workspaceId: string,
    mainWindowId: string,
  ) {
    return this.database.transaction(async (tx) => {
      if (!(await ownedProject(tx, ownerId, projectId))) return null;
      const [existing] = await tx
        .select()
        .from(schema.workspaceLayouts)
        .where(scope(ownerId, projectId, workspaceId));
      if (existing) return this.seeded(existing.layout, mainWindowId);
      // Read only server-owned legacy state; callers cannot import arbitrary resources.
      const legacy = await new ProjectTabLayoutRepository(tx).get(
        ownerId,
        projectId,
      );
      if (!legacy) return null;
      const layout = seedWorkspaceOwnership({
        workspaceId,
        mainWindowId,
        legacy,
      });
      validatePlacements(layout);
      await tx
        .insert(schema.workspaceLayouts)
        .values({ ownerId, projectId, workspaceId, layout })
        .onConflictDoNothing();
      // Concurrent seeds converge on the first committed identity rather than overwriting it.
      const [row] = await tx
        .select()
        .from(schema.workspaceLayouts)
        .where(scope(ownerId, projectId, workspaceId));
      return this.seeded(row!.layout, mainWindowId);
    });
  }

  private seeded(value: WorkspaceOwnership, mainWindowId: string) {
    const layout = workspaceOwnershipSchema.parse(value);
    if (layout.mainWindowId !== mainWindowId)
      throw new WorkspaceCommandError(
        "scope",
        "This workspace already has a different main window.",
      );
    return layout;
  }

  async execute(ownerId: string, input: WorkspaceCommand) {
    const command = workspaceCommandSchema.parse(input);
    const { projectId, workspaceId, operationId } = command;
    return this.database.transaction(async (tx) => {
      if (!(await ownedProject(tx, ownerId, projectId))) return null;
      const [row] = await tx
        .select()
        .from(schema.workspaceLayouts)
        .where(scope(ownerId, projectId, workspaceId))
        .for("update");
      if (!row) return null;
      const layout = workspaceOwnershipSchema.parse(row.layout);
      const window = layout.windows.find((w) => w.id === command.windowId);
      if (
        !window ||
        window.attachmentGeneration !== command.attachmentGeneration
      ) {
        throw new WorkspaceCommandError(
          "attachment",
          "The window attachment is no longer current.",
        );
      }
      const [receipt] = await tx
        .select()
        .from(schema.workspaceCommandReceipts)
        .where(
          and(
            eq(schema.workspaceCommandReceipts.ownerId, ownerId),
            eq(schema.workspaceCommandReceipts.projectId, projectId),
            eq(schema.workspaceCommandReceipts.workspaceId, workspaceId),
            eq(schema.workspaceCommandReceipts.operationId, operationId),
          ),
        );
      if (receipt) {
        if (!isDeepStrictEqual(receipt.command, command))
          throw new WorkspaceCommandError(
            "invalid",
            "The operation identity was already used for another command.",
          );
        // A receipt acknowledges the old operation without replaying native effects or
        // replacing newer authoritative state with the old result snapshot.
        return {
          layout,
          operationId,
          appliedRevision: receipt.appliedRevision,
          replayed: true,
          focusWindowId: null,
          emptyWindowIds: [] as string[],
        };
      }
      if (command.action.type === "open") {
        const resource = command.action.tab.resource;
        if (
          resource.kind === "entity" &&
          !(await resolveEntitySurface(tx, projectId, resource))
        ) {
          throw new WorkspaceCommandError(
            "missing",
            "The resource is unavailable in this project.",
          );
        }
        const worktreeId = command.action.tab.builtInState?.worktreeId;
        if (worktreeId) {
          const [worktree] = await tx
            .select({ id: schema.projectWorktrees.id })
            .from(schema.projectWorktrees)
            .innerJoin(
              schema.projectSources,
              eq(
                schema.projectSources.id,
                schema.projectWorktrees.projectSourceId,
              ),
            )
            .where(
              and(
                eq(schema.projectWorktrees.id, worktreeId),
                eq(schema.projectSources.projectId, projectId),
                eq(schema.projectWorktrees.lifecycleState, "ready"),
                isNull(schema.projectSources.removedAt),
              ),
            );
          if (!worktree)
            throw new WorkspaceCommandError(
              "missing",
              "The worktree is unavailable in this project.",
            );
        }
      }
      const result = applyWorkspaceCommand(layout, command);
      validatePlacements(result.layout);
      await tx
        .update(schema.workspaceLayouts)
        .set({ layout: result.layout })
        .where(scope(ownerId, projectId, workspaceId));
      await tx
        .insert(schema.workspaceCommandReceipts)
        .values({
          ownerId,
          projectId,
          workspaceId,
          operationId,
          command,
          appliedRevision: result.layout.revision,
        });
      return {
        ...result,
        appliedRevision: result.layout.revision,
        replayed: false,
      };
    });
  }
}
