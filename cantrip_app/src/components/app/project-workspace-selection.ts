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
  projectSurfaceIsFile,
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
            groupId: popoutTarget.groupId,
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
    const pendingGroup = pendingSurfaceSelection?.groupId
      ? layout.groups.find(({ id }) => id === pendingSurfaceSelection.groupId)
      : undefined;
    const pendingTabKey =
      pendingSurfaceSelection?.projectId === selectedProjectId &&
      layout.groups.some(({ members }) =>
        members.some(({ tabKey }) => tabKey === pendingSurfaceSelection.tabKey),
      )
        ? pendingSurfaceSelection.tabKey
        : (pendingGroup?.anchorTabKey ?? null);
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

export function useProjectSurfaceSelection({
  resources,
  selectedTabKey,
}: {
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
  const projectSurfaceIndex = useMemo(
    () =>
      buildProjectSurfaceIndex(resources.tabLayout.data, {
        browsers: resources.browsers.data ?? [],
        chats: resources.chats.data ?? [],
        codeTabs: resources.codeTabs.data ?? [],
        explorers: resources.explorers.data ?? [],
        projectViews: resources.projectViews.data ?? [],
        terminals: displayTerminals,
      }),
    [
      resources.browsers.data,
      resources.chats.data,
      resources.codeTabs.data,
      resources.explorers.data,
      resources.projectViews.data,
      resources.tabLayout.data,
      displayTerminals,
    ],
  );
  return {
    displayTerminals,
    projectSurfaceIndex,
    selectedSurface: selectedTabKey
      ? projectSurfaceIndex.byTabKey.get(selectedTabKey)
      : undefined,
  } as const;
}

export function workspaceGroupSelection({
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
    tabLayout?.groups.flatMap(
      ({ id }) => projectSurfaceIndex.byGroupId.get(id) ?? [],
    ) ?? [];
  const selectedTabGroup = tabLayout?.groups.find(
    (group) => group.id === workspaceSelection.selectedGroupId,
  );
  const selectedGroupSurfaces = workspaceSelection.selectedGroupId
    ? (projectSurfaceIndex.byGroupId.get(workspaceSelection.selectedGroupId) ??
      [])
    : [];
  return {
    projectSidebarSurfaces: orderedProjectSurfaces.filter(
      (surface) => !projectSurfaceIsFile(surface),
    ),
    projectTabBarSurfaces: orderedProjectSurfaces.filter(projectSurfaceIsFile),
    selectedGroupSurfaces,
    selectedTabGroup,
    showSidebarPreviewTab: Boolean(
      sidebarFilePreview &&
      (sidebarFilePreview.active ||
        (sidebarFilePreview.groupId !== null &&
          sidebarFilePreview.groupId === workspaceSelection.selectedGroupId)),
    ),
  } as const;
}
