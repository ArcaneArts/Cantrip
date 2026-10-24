import { connectWorkspaceCommands } from "./api/workspace-layouts";
import { getProjectTabLayout } from "./api";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "./client-session";
import {
  discoverDesktopPopoutPanes,
  currentDesktopWorkspaceWindowId,
  closeRetiredWorkspaceWindow,
} from "./desktop-popout";
import { readWorkspaceDeviceIdentity } from "./workspace-device-identity";
import type { WorkspaceSelection } from "./workspace-selection";
import { WorkspacePresentationStore } from "./workspace-presentation-store";
import { workspaceRendererLifetime } from "./workspace-renderer-lifetime";
import { WorkspaceWindowRetiredError } from "./workspace-renderer-attachment";

export interface WorkspaceBootstrapDependencies {
  device: typeof readWorkspaceDeviceIdentity;
  legacy: typeof getProjectTabLayout;
  detached: typeof discoverDesktopPopoutPanes;
  connect: typeof connectWorkspaceCommands;
  renderer: typeof workspaceRendererLifetime;
  retire: typeof closeRetiredWorkspaceWindow;
}
const dependencies: WorkspaceBootstrapDependencies = {
  device: readWorkspaceDeviceIdentity,
  legacy: getProjectTabLayout,
  detached: discoverDesktopPopoutPanes,
  connect: connectWorkspaceCommands,
  renderer: workspaceRendererLifetime,
  retire: closeRetiredWorkspaceWindow,
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
  const lifetime = await io.renderer({
    serverId: identity.serverId,
    ownerId: identity.userId,
    workspaceId: scope.workspaceId,
    windowId,
  });
  try {
    assertSession();
  } catch (error) {
    lifetime.releaseConnection?.();
    throw error;
  }
  const connection = await io
    .connect(
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
      lifetime,
    )
    .catch(async (error: unknown) => {
      lifetime.releaseConnection?.();
      assertSession();
      lifetime.signal.throwIfAborted();
      if (
        error instanceof WorkspaceWindowRetiredError &&
        error.windowId === windowId &&
        windowId !== scope.mainWindowId
      ) {
        await io.retire(windowId);
      }
      throw error;
    });
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
