import {
  legacyTopStripPresentation,
  visibleWorkspacePanes,
} from "./project-workspace-frame-model";
import { projectPaneRenderBindings } from "./project-pane-render-bindings";

/** The main tab strip owns desktop window chrome; dock focus stays local. */
export function windowHeaderBindings(bindings: Readonly<Record<string, any>>) {
  if (
    bindings.appMode !== "ide" ||
    bindings.compactShell ||
    bindings.isPopout ||
    !bindings.selectedProject ||
    !bindings.tabLayout?.data ||
    bindings.showImporter ||
    bindings.showSettings ||
    bindings.showProjectSettings ||
    bindings.showProjectOverview ||
    bindings.showServerAdmin ||
    bindings.showArchivedStandaloneChats
  ) {
    return bindings;
  }
  const main = legacyTopStripPresentation(
    visibleWorkspacePanes({
      activeTabByPane: bindings.workspaceSelection.activeTabByPane,
      centerRoot: bindings.tabLayout.data.centerRoot,
      focusedPaneId: bindings.workspaceSelection.focusedPaneId,
      panes: bindings.tabLayout.data.panes,
      surfaceByPaneId: bindings.projectSurfaceIndex.byPaneId,
    }),
  );
  if (!main?.activeSurface) {
    return { ...bindings, windowContentEmpty: true };
  }
  if (main.focused && bindings.selectedSurface?.tabKey === main.activeTabKey)
    return bindings;

  const local = projectPaneRenderBindings(bindings, {
    ...main,
    focused: false,
  });
  const worktreeId =
    local.activeChat?.activeWorktreeId ??
    local.selectedTerminal?.worktreeId ??
    local.selectedExplorer?.worktreeId ??
    local.selectedCodeTab?.worktreeId ??
    local.selectedFileDocument?.worktreeId ??
    local.selectedProjectView?.worktreeId ??
    local.selectedBuiltInSurface?.entity.worktreeId;
  const worktree = bindings.worktrees.data?.find(
    ({ id }: { id: string }) => id === worktreeId,
  );
  return {
    ...local,
    activeWorktree: worktree,
    activeWorktreeId: worktreeId,
    // Published headers and binding actions belong to the focused pane.
    activeWorktreeTarget: null,
    activeExplorerHeader: null,
    codeHeader: null,
    gitHistoryHeader: null,
    explorerDisplayPath:
      worktree?.displayPath ?? bindings.selectedProject.source?.displayPath,
  };
}
