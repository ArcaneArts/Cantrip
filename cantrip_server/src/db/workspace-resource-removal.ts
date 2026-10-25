import {
  applyWorkspaceCommand,
  workspaceOwnershipSchema,
  type ProjectSurfaceDefinitionId,
} from "@cantrip/protocol";
import { and, asc, eq } from "drizzle-orm";
import type { RepositoryTransaction } from "./repository/database.js";
import * as schema from "./schema.js";

/** Called only by authorized resource deletion, inside its transaction. */
export async function removeResourceWorkspaceViews(
  tx: RepositoryTransaction,
  ownerId: string,
  projectId: string,
  definitionId: ProjectSurfaceDefinitionId,
  resourceId: string,
) {
  // Command execution and seeding take a shared project lock. Serialize deletion
  // against their resource validation so a concurrent open cannot resurrect a view.
  const [project] = await tx
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.ownerId, ownerId),
      ),
    )
    .for("update");
  if (!project) return;
  const rows = await tx
    .select()
    .from(schema.workspaceLayouts)
    .where(
      and(
        eq(schema.workspaceLayouts.ownerId, ownerId),
        eq(schema.workspaceLayouts.projectId, projectId),
      ),
    )
    .orderBy(asc(schema.workspaceLayouts.workspaceId))
    .for("update");
  for (const row of rows) {
    let layout = workspaceOwnershipSchema.parse(row.layout);
    const removals = layout.windows.flatMap((window) =>
      window.panes.flatMap((pane) =>
        pane.tabs
          .filter(
            (tab) =>
              tab.resource.kind === "entity" &&
              (tab.resource.definitionId === definitionId ||
                (definitionId === "project.explorer" &&
                  tab.resource.definitionId === "project.file")) &&
              tab.resource.resourceId === resourceId,
          )
          .map((tab) => ({
            windowId: window.id,
            generation: window.attachmentGeneration,
            tabId: tab.id,
          })),
      ),
    );
    for (const removal of removals) {
      layout = applyWorkspaceCommand(layout, {
        projectId,
        workspaceId: layout.id,
        windowId: removal.windowId,
        attachmentGeneration: removal.generation,
        expectedRevision: layout.revision,
        operationId: `resource-removal:${resourceId}:${removal.tabId}`,
        action: { type: "close-tab", tabId: removal.tabId },
      }).layout;
    }
    if (removals.length)
      await tx
        .update(schema.workspaceLayouts)
        .set({ layout })
        .where(
          and(
            eq(schema.workspaceLayouts.ownerId, ownerId),
            eq(schema.workspaceLayouts.projectId, projectId),
            eq(schema.workspaceLayouts.workspaceId, row.workspaceId),
          ),
        );
  }
}
