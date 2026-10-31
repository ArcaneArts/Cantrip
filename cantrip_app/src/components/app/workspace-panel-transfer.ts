import {
  projectBuiltInSurfaceStateSchema,
  projectSurfaceResourceRefSchema,
  type ProjectSurfaceResourceRef,
  type WorkspaceTab,
} from "@cantrip/protocol";
import { z } from "zod";

/** Panels without an exclusive runtime rebuild from the committed workspace.
 * The snapshot binds their saved view/worktree state to the same reservation as
 * live editors. Run output uses this path too; its runtime stays on the worker. */
const panelSchema = z
  .object({
    tabId: z.string().min(1),
    projectId: z.string().min(1),
    resource: projectSurfaceResourceRefSchema,
    builtInState: projectBuiltInSurfaceStateSchema.nullable(),
  })
  .strict();
export type WorkspacePanelTransfer = z.infer<typeof panelSchema>;

export function isWorkspacePanelResource(resource: ProjectSurfaceResourceRef) {
  return (
    resource.kind === "builtin" ||
    resource.definitionId === "project.git-history" ||
    resource.definitionId === "project.git-graph" ||
    resource.definitionId === "project.github-issues" ||
    resource.definitionId === "project.github-pull-requests" ||
    resource.definitionId === "project.github-actions"
  );
}

export function workspacePanelTransfer(
  tab: Pick<WorkspaceTab, "id" | "resource" | "builtInState">,
  projectId: string,
): WorkspacePanelTransfer {
  return panelSchema.parse({
    tabId: tab.id,
    projectId,
    resource: tab.resource,
    builtInState: tab.builtInState ?? null,
  });
}

export function validateWorkspacePanelTransfer(
  value: unknown,
  expected: WorkspacePanelTransfer,
) {
  const state = panelSchema.parse(value);
  if (JSON.stringify(state) !== JSON.stringify(panelSchema.parse(expected)))
    throw new Error("Transferred panel does not match its reservation.");
  return state;
}
