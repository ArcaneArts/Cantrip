import { connectWorkspaceCommands } from "./api/workspace-layouts";
import { getProjectTabLayout } from "./api";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "./client-session";
import {
  discoverDesktopPopoutPanes,
  currentDesktopWorkspaceWindowId,
} from "./desktop-popout";
import { readWorkspaceDeviceIdentity } from "./workspace-device-identity";
import type { WorkspaceSelection } from "./workspace-selection";
import { WorkspacePresentationStore } from "./workspace-presentation-store";

export interface WorkspaceBootstrapDependencies {
  device: typeof readWorkspaceDeviceIdentity;
  legacy: typeof getProjectTabLayout;
  detached: typeof discoverDesktopPopoutPanes;
  connect: typeof connectWorkspaceCommands;
}
const dependencies: WorkspaceBootstrapDependencies = {
  device: readWorkspaceDeviceIdentity,
  legacy: getProjectTabLayout,
  detached: discoverDesktopPopoutPanes,
  connect: connectWorkspaceCommands,
};

/** The shell's one initialization path. Native callers pass their actual label
 * for a popout; main and mobile callers omit it. No query-cache fallback seed. */
export async function bootstrapWorkspace(
  projectId: string,
  selection: WorkspaceSelection,
  nativeWindowId?: string,
  io: WorkspaceBootstrapDependencies = dependencies,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before opening a workspace.");
  const assertSession = () => {
    if (!clientSessionIdentityMatches(identity))
      throw new Error("Workspace session changed during initialization.");
  };
  const scope = await io.device(identity, projectId);
  assertSession();
  const windowId =
    nativeWindowId ??
    (await currentDesktopWorkspaceWindowId()) ??
    scope.mainWindowId;
  assertSession();
  const connection = await io.connect(
    projectId,
    scope.workspaceId,
    windowId,
    async () => {
      assertSession();
      const legacy = await io.legacy(projectId);
      assertSession();
      const detachedPanes = await io.detached(
        legacy.panes.map((pane) => pane.id),
      );
      assertSession();
      return {
        mainWindowId: scope.mainWindowId,
        detachedPanes,
        ...(selection.projectId === projectId
          ? {
              activeTabByPane: { ...selection.activeTabByPane },
              focusedPaneId:
                selection.destination === "surface"
                  ? selection.focusedPaneId
                  : null,
            }
          : {}),
      };
    },
  );
  try {
    assertSession();
  } catch (error) {
    connection.dispose();
    throw error;
  }
  const presentation = new WorkspacePresentationStore(
    connection.controller,
    windowId,
  );
  return {
    ...connection,
    ...scope,
    windowId,
    presentation,
    dispose: () => {
      presentation.dispose();
      connection.dispose();
    },
  };
}
