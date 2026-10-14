import {
  projectViewWireListSchema,
  projectViewWireSummarySchema,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import type { ProjectViewKind, ProjectPaneRegion } from "@cantrip/protocol";

export async function getProjectViews(projectId: string) {
  const views = projectViewWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/views`),
  );
  return Promise.all(
    views.map((view) => surfaceTitleEncryption.openProjectView(view)),
  );
}

export async function createProjectView(
  projectId: string,
  kind: Exclude<ProjectViewKind, "remote-desktop">,
  title: string,
  worktreeId?: string,
  paneId?: string,
  targetRegion?: ProjectPaneRegion,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "project-view",
  );
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/views`, {
        id,
        titleProtection,
        kind,
        ...(worktreeId ? { worktreeId } : {}),
        ...(paneId ? { paneId } : {}),
        ...(targetRegion ? { targetRegion } : {}),
      }),
    ),
  );
}

export async function updateProjectViewWorktree(
  viewId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await request(
        `/api/project-views/${encodeURIComponent(viewId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function renameProjectView(viewId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    viewId,
    title,
    "project-view",
  );
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function deleteProjectView(viewId: string) {
  await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
    method: "DELETE",
  });
}
