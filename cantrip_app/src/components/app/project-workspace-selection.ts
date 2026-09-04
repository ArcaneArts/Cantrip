import type { AppMode, ProjectTabLayoutSummary } from "@cantrip/protocol";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PendingSurfaceSelection } from "@/components/app/shell-navigation";
import type { ShellEnvironment } from "@/components/app/shell-environment";
import type { ProjectInventory } from "@/components/app/project-inventory";
import type { ProjectWorkspaceResources } from "@/components/app/project-workspace-resources";
import { useAppLiveScope } from "@/lib/app-live-react";
import {
  buildProjectSurfaceIndex,
  omitProjectSurfaceTabs,
  projectSurfaceTabId,
} from "@/lib/project-surface";
import {
  projectsInWorkspace,
  resolveProjectWorkspace,
} from "@/lib/project-workspaces";
import { decorateRunConfigurationTerminals } from "@/lib/run-terminal-model";
import type { SidebarFilePreviewState } from "@/lib/sidebar-file-tabs";
import {
  emptyWorkspaceSelection,
  reconcileWorkspaceSelection,
  selectedWorkspaceTabKey,
  selectWorkspaceTab,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export function useProjectWorkspaceSelectionState({
  popoutProjectId,
  popoutTarget,
}: Pick<ShellEnvironment, "popoutProjectId" | "popoutTarget">) {
  const [workspaceSelection, setWorkspaceSelection] = useState(() =>
    emptyWorkspaceSelection(popoutProjectId),
  );
  const [pendingSurfaceSelection, setPendingSurfaceSelection] =
    useState<PendingSurfaceSelection | null>(
      popoutTarget
        ? {
            paneId: popoutTarget.groupId,
            projectId: popoutTarget.projectId,
            tabKey: popoutTarget.activeTabKey,
          }
        : null,
    );
  return {
    pendingSurfaceSelection,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
    workspaceSelection,
  } as const;
}

export function projectWorkspaceSurfaceSelection(
  workspaceSelection: WorkspaceSelection,
) {
  const selectedTabKey = selectedWorkspaceTabKey(workspaceSelection);
  return {
    selectedBrowserId: projectSurfaceTabId(selectedTabKey, "browser"),
    selectedChatId: projectSurfaceTabId(selectedTabKey, "chat"),
    selectedCodeTabId: projectSurfaceTabId(selectedTabKey, "code"),
    selectedExplorerId: projectSurfaceTabId(selectedTabKey, "explorer"),
    selectedProjectViewId: projectSurfaceTabId(selectedTabKey, "view"),
    selectedTabKey,
    selectedTerminalId: projectSurfaceTabId(selectedTabKey, "terminal"),
  } as const;
}

export function useWorkspaceLiveScopes({
  appMode,
  selectedChatId,
  selectedProjectId,
  selectedStandaloneChatId,
}: {
  appMode: AppMode | null;
  selectedChatId: string | null;
  selectedProjectId: string | null;
  selectedStandaloneChatId: string | null;
}) {
  useAppLiveScope(
    selectedProjectId
      ? { kind: "project", projectId: selectedProjectId }
      : null,
  );
  useAppLiveScope(
    selectedChatId ? { kind: "chat", chatId: selectedChatId } : null,
  );
  useAppLiveScope(
    appMode === "chat" && selectedStandaloneChatId
      ? { kind: "chat", chatId: selectedStandaloneChatId }
      : null,
  );
}

export function useWorkspaceSelectionReconciliation({
  layout,
  pendingSurfaceSelection,
  selectedProjectId,
  setPendingSurfaceSelection,
  setWorkspaceSelection,
}: {
  layout: ProjectTabLayoutSummary | undefined;
  pendingSurfaceSelection: PendingSurfaceSelection | null;
  selectedProjectId: string | null;
  setPendingSurfaceSelection: Dispatch<
    SetStateAction<PendingSurfaceSelection | null>
  >;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
}) {
  useEffect(() => {
    if (!selectedProjectId) {
      setWorkspaceSelection(emptyWorkspaceSelection());
      return;
    }
    if (!layout || layout.projectId !== selectedProjectId) return;
    const pendingPane = pendingSurfaceSelection?.paneId
      ? layout.panes.find(({ id }) => id === pendingSurfaceSelection.paneId)
      : undefined;
    const pendingTabKey =
      pendingSurfaceSelection?.projectId === selectedProjectId &&
      layout.panes.some(({ members }) =>
        members.some(({ tabKey }) => tabKey === pendingSurfaceSelection.tabKey),
      )
        ? pendingSurfaceSelection.tabKey
        : (pendingPane?.anchorTabKey ?? null);
    setWorkspaceSelection((current) => {
      const reconciled = reconcileWorkspaceSelection(
        current,
        layout,
        pendingTabKey,
      );
      return pendingTabKey
        ? selectWorkspaceTab(reconciled, layout, pendingTabKey)
        : reconciled;
    });
    if (pendingTabKey) setPendingSurfaceSelection(null);
  }, [
    layout,
    pendingSurfaceSelection,
    selectedProjectId,
    setPendingSurfaceSelection,
    setWorkspaceSelection,
  ]);
}

export function useActiveProjectWorkspace({
  activeProjectWorkspaceId,
  inventory,
}: {
  activeProjectWorkspaceId: string | null;
  inventory: Pick<ProjectInventory, "projects" | "projectWorkspaces">;
}) {
  const activeProjectWorkspace = resolveProjectWorkspace(
    inventory.projectWorkspaces.data ?? [],
    activeProjectWorkspaceId,
  );
  const visibleProjects = useMemo(
    () =>
      projectsInWorkspace(
        inventory.projects.data ?? [],
        activeProjectWorkspace,
      ),
    [activeProjectWorkspace, inventory.projects.data],
  );
  return { activeProjectWorkspace, visibleProjects } as const;
}

const noOmittedTabKeys: ReadonlySet<string> = new Set();

export function useProjectSurfaceSelection({
  omittedTabKeys = noOmittedTabKeys,
  resources,
  selectedTabKey,
}: {
  omittedTabKeys?: ReadonlySet<string>;
  resources: Pick<
    ProjectWorkspaceResources,
    | "browsers"
    | "chats"
    | "codeTabs"
    | "explorers"
    | "projectViews"
    | "runConfigurations"
    | "tabLayout"
    | "terminals"
    | "worktrees"
  >;
  selectedTabKey: string | null;
}) {
  const displayTerminals = useMemo(
    () =>
      decorateRunConfigurationTerminals(
        resources.terminals.data ?? [],
        resources.runConfigurations.data,
        resources.worktrees.data ?? [],
      ),
    [
      resources.runConfigurations.data,
      resources.terminals.data,
      resources.worktrees.data,
    ],
  );
  const projectSurfaceIndex = useMemo(() => {
    const index = buildProjectSurfaceIndex(resources.tabLayout.data, {
      browsers: resources.browsers.data ?? [],
      chats: resources.chats.data ?? [],
      codeTabs: resources.codeTabs.data ?? [],
      explorers: resources.explorers.data ?? [],
      projectViews: resources.projectViews.data ?? [],
      terminals: displayTerminals,
    });
    return omitProjectSurfaceTabs(index, omittedTabKeys);
  }, [
    omittedTabKeys,
    resources.browsers.data,
    resources.chats.data,
    resources.codeTabs.data,
    resources.explorers.data,
    resources.projectViews.data,
    resources.tabLayout.data,
    displayTerminals,
  ]);
  return {
    displayTerminals,
    projectSurfaceIndex,
    selectedSurface: selectedTabKey
      ? projectSurfaceIndex.byTabKey.get(selectedTabKey)
      : undefined,
  } as const;
}

export function workspacePaneSelection({
  projectSurfaceIndex,
  sidebarFilePreview,
  tabLayout,
  workspaceSelection,
}: {
  projectSurfaceIndex: ReturnType<typeof buildProjectSurfaceIndex>;
  sidebarFilePreview: SidebarFilePreviewState | null;
  tabLayout: ProjectTabLayoutSummary | undefined;
  workspaceSelection: WorkspaceSelection;
}) {
  const orderedProjectSurfaces =
    tabLayout?.panes.flatMap(
      ({ id }) => projectSurfaceIndex.byPaneId.get(id) ?? [],
    ) ?? [];
  const selectedPane = tabLayout?.panes.find(
    (pane) => pane.id === workspaceSelection.focusedPaneId,
  );
  const selectedPaneSurfaces = workspaceSelection.focusedPaneId
    ? (projectSurfaceIndex.byPaneId.get(workspaceSelection.focusedPaneId) ?? [])
    : [];
  return {
    orderedProjectSurfaces,
    selectedPaneSurfaces,
    selectedPane,
    showSidebarPreviewTab: Boolean(
      sidebarFilePreview &&
      (sidebarFilePreview.active ||
        (sidebarFilePreview.paneId !== null &&
          sidebarFilePreview.paneId === workspaceSelection.focusedPaneId)),
    ),
  } as const;
}
