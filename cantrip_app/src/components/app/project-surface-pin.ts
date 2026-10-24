import { useMutation } from "@tanstack/react-query";
import type { ProjectSurface } from "@/lib/project-surface";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";

export async function pinProjectSurface(
  workspace: { controller: WorkspaceCommandClient } | null,
  surface: ProjectSurface,
) {
  if (surface.kind !== "file" || !surface.preview) return;
  if (!workspace) throw new Error("Workspace connection is not ready.");
  if (
    workspace.controller.getSnapshot().authoritative.projectId !==
    surface.projectId
  )
    throw new Error("Workspace command belongs to another project.");
  await workspace.controller.dispatch({ type: "pin", tabId: surface.tabKey });
}

export function useProjectSurfacePin(
  workspace: { controller: WorkspaceCommandClient } | null,
  onError: (error: Error) => void,
) {
  return useMutation({
    mutationFn: (surface: ProjectSurface) =>
      pinProjectSurface(workspace, surface),
    onError,
  });
}
