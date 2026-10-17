import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import {
  projectTabLayoutWireSummarySchema,
  projectPaneOrderSchema,
  projectPaneUpdateSchema,
  encryptedProjectPaneUpdateSchema,
  projectPaneMemberOrderSchema,
  projectPaneMemberMoveSchema,
  projectPaneMemberSplitSchema,
  projectCenterSplitResizeSchema,
  projectDockPresentationUpdateSchema,
  type ProjectSurfaceResourceRef,
  projectSurfaceViewOpenResultSchema,
  projectSurfaceViewOpenSchema,
  projectSurfaceViewCloseResultSchema,
  projectSurfaceViewCloseSchema,
  projectSurfaceLauncherListSchema,
  type ProjectSurfaceLauncherPin,
  projectSurfaceLauncherSchema,
  projectSurfaceLauncherPinSchema,
  type ProjectBuiltInSurfaceDefinitionId,
} from "@cantrip/protocol";
import { request, post } from "@/lib/api-client";

export async function getProjectTabLayout(projectId: string) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(`/api/projects/${encodeURIComponent(projectId)}/panes`),
    ),
  );
}

export async function reorderProjectPanes(
  projectId: string,
  revision: number,
  region: "center" | "right" | "bottom" | "left",
  paneIds: string[],
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/order`,
        {
          method: "PATCH",
          body: JSON.stringify(
            projectPaneOrderSchema.parse({ revision, region, paneIds }),
          ),
        },
      ),
    ),
  );
}

export async function updateProjectPane(
  projectId: string,
  paneId: string,
  revision: number,
  title: string,
) {
  const input = projectPaneUpdateSchema.parse({ revision, title });
  const titleProtection = await chatTitleEncryption.protectTabGroup(
    paneId,
    input.title,
  );
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/${encodeURIComponent(paneId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            encryptedProjectPaneUpdateSchema.parse({
              revision: input.revision,
              titleProtection,
            }),
          ),
        },
      ),
    ),
  );
}

export async function reorderProjectPaneMembers(
  projectId: string,
  paneId: string,
  revision: number,
  tabKeys: string[],
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/${encodeURIComponent(paneId)}/members/order`,
        {
          method: "PATCH",
          body: JSON.stringify(
            projectPaneMemberOrderSchema.parse({ revision, tabKeys }),
          ),
        },
      ),
    ),
  );
}

export async function moveProjectPaneMember(
  projectId: string,
  input: {
    revision: number;
    tabKey: string;
    targetPaneId: string | null;
    targetMemberPosition: number;
    targetPanePosition?: number;
    targetRegion?: "center" | "right" | "bottom" | "left";
  },
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/member`,
        {
          method: "PATCH",
          body: JSON.stringify(projectPaneMemberMoveSchema.parse(input)),
        },
      ),
    ),
  );
}

export async function splitProjectPaneMember(
  projectId: string,
  input: {
    edge: "left" | "right" | "top" | "bottom";
    fraction?: number;
    revision: number;
    tabKey: string;
    targetPaneId: string;
  },
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/member/split`,
        {
          method: "PATCH",
          body: JSON.stringify(projectPaneMemberSplitSchema.parse(input)),
        },
      ),
    ),
  );
}

export async function resizeProjectCenterSplit(
  projectId: string,
  splitId: string,
  revision: number,
  fraction: number,
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/splits/${encodeURIComponent(splitId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            projectCenterSplitResizeSchema.parse({ revision, fraction }),
          ),
        },
      ),
    ),
  );
}

export async function updateProjectPaneMemberPresentation(
  projectId: string,
  input: {
    preferredMode: "closed" | "split" | "full";
    restoreFraction: number;
    revision: number;
    splitFraction: number;
    tabKey: string;
  },
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/panes/member/presentation`,
        {
          method: "PATCH",
          body: JSON.stringify(
            projectDockPresentationUpdateSchema.parse(input),
          ),
        },
      ),
    ),
  );
}

export async function openProjectSurfaceView(
  projectId: string,
  input: {
    revision: number;
    surfaceRef: ProjectSurfaceResourceRef;
    targetPaneId?: string;
    targetRegion?: "center" | "right" | "bottom" | "left";
  },
) {
  const wire = projectSurfaceViewOpenResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/panes/member/open`,
      projectSurfaceViewOpenSchema.parse(input),
    ),
  );
  return {
    ...wire,
    layout: await chatTitleEncryption.openTabLayout(wire.layout),
  };
}

export async function closeProjectSurfaceView(
  projectId: string,
  revision: number,
  viewId: string,
) {
  const wire = projectSurfaceViewCloseResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/panes/member/close`,
      projectSurfaceViewCloseSchema.parse({ revision, viewId }),
    ),
  );
  return {
    ...wire,
    layout: await chatTitleEncryption.openTabLayout(wire.layout),
  };
}

export async function getProjectSurfaceLaunchers(projectId: string) {
  return projectSurfaceLauncherListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/surface-launchers`,
    ),
  );
}

export async function updateProjectSurfaceLauncher(
  projectId: string,
  input: ProjectSurfaceLauncherPin,
) {
  return projectSurfaceLauncherSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/surface-launchers`,
      {
        method: "PATCH",
        body: JSON.stringify(projectSurfaceLauncherPinSchema.parse(input)),
      },
    ),
  );
}

export async function updateBuiltInSurfaceWorktree(
  projectId: string,
  definitionId: ProjectBuiltInSurfaceDefinitionId,
  worktreeId: string,
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/builtin-surfaces/${encodeURIComponent(definitionId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}
