import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { MobileBottomNavigationItem } from "@/components/mobile/mobile-bottom-navigation";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  assignMobileBottomTab,
  initialMobileBottomTabs,
  mobileBottomTabConfiguration,
  mobileBottomTabsFromConfiguration,
  PRIMARY_MOBILE_BOTTOM_TAB_ID,
  reconcileMobileBottomTabs,
  removeMobileBottomTab,
} from "@/lib/mobile-navigation";
import type { ProjectSurfaceIndex } from "@/lib/project-surface";
import { updateSettings } from "@/lib/api";
import {
  selectWorkspaceOverview,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export function useMobileProjectNavigationState() {
  const [mobileTabGridOpen, setMobileTabGridOpen] = useState(false);
  const [mobileBottomTabs, setMobileBottomTabs] = useState(
    initialMobileBottomTabs,
  );
  const [mobileBottomTabsProjectId, setMobileBottomTabsProjectId] = useState<
    string | null
  >(null);
  const [activeMobileBottomTabId, setActiveMobileBottomTabId] = useState(
    PRIMARY_MOBILE_BOTTOM_TAB_ID,
  );
  return {
    activeMobileBottomTabId,
    mobileBottomTabs,
    mobileBottomTabsProjectId,
    mobileTabGridOpen,
    setActiveMobileBottomTabId,
    setMobileBottomTabs,
    setMobileBottomTabsProjectId,
    setMobileTabGridOpen,
  } as const;
}

type MobileProjectNavigationState = ReturnType<
  typeof useMobileProjectNavigationState
>;

export function useMobileProjectNavigationRefs() {
  const mobileBottomTabSequenceRef = useRef(0);
  const persistedMobileBottomTabsRef = useRef<{
    projectId: string;
    signature: string;
  } | null>(null);
  return { mobileBottomTabSequenceRef, persistedMobileBottomTabsRef } as const;
}

type MobileProjectNavigationRefs = ReturnType<
  typeof useMobileProjectNavigationRefs
>;

export function resetMobileProjectNavigation(
  state: MobileProjectNavigationState,
  refs: MobileProjectNavigationRefs,
) {
  state.setMobileBottomTabs(initialMobileBottomTabs());
  state.setMobileBottomTabsProjectId(null);
  state.setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
  state.setMobileTabGridOpen(false);
  refs.mobileBottomTabSequenceRef.current = 0;
  refs.persistedMobileBottomTabsRef.current = null;
}

export function useMobileBottomTabsPersistence(queryClient: QueryClient) {
  return useMutation({
    mutationFn: async ({
      groupIds,
      projectId,
    }: {
      groupIds: (string | null)[];
      projectId: string;
    }) =>
      updateSettings({
        mobileProjectTabConfigurations: {
          [projectId]: groupIds,
        },
      }),
    onError: (error) => {
      clientLogger.warn("Mobile project tab state failed to save", {
        ...operationalErrorMetadata(error),
        event: "tabs.mobile.save.failed",
        operation: "save-layout",
        reasonCode: "request-failed",
        status: "rolled-back",
        subsystem: "tabs",
      });
    },
    onSuccess: (bundle) => queryClient.setQueryData(["settings"], bundle),
    retry: 2,
    scope: { id: "mobile-project-tab-configurations" },
  });
}

export function mobileProjectShellModel({
  appMode,
  compactShell,
  projectOverviewSelected,
  selectedProject,
  selectedProjectId,
  showArchivedStandaloneChats,
  showImporter,
  showProjectSettings,
  showServerAdmin,
  showSettings,
  mobileTabGridOpen,
}: {
  appMode: "chat" | "ide" | null;
  compactShell: boolean;
  projectOverviewSelected: boolean;
  selectedProject: boolean;
  selectedProjectId: string | null;
  showArchivedStandaloneChats: boolean;
  showImporter: boolean;
  showProjectSettings: boolean;
  showServerAdmin: boolean;
  showSettings: boolean;
  mobileTabGridOpen: boolean;
}) {
  const mobileProjectSelectorOpen =
    appMode === "ide" &&
    compactShell &&
    selectedProjectId === null &&
    !showImporter &&
    !showSettings &&
    !showServerAdmin &&
    !showProjectSettings;
  const compactManagedHeader =
    compactShell &&
    (showArchivedStandaloneChats ||
      showImporter ||
      showSettings ||
      showServerAdmin ||
      (appMode === "ide" &&
        (mobileProjectSelectorOpen ||
          showProjectSettings ||
          mobileTabGridOpen ||
          (projectOverviewSelected && selectedProject))));
  return { compactManagedHeader, mobileProjectSelectorOpen } as const;
}

export function useMobileProjectNavigationModel({
  projectSurfaceIndex,
  selectedProjectId,
  state,
  tabLayout,
  workspaceSelection,
}: {
  projectSurfaceIndex: ProjectSurfaceIndex;
  selectedProjectId: string | null;
  state: MobileProjectNavigationState;
  tabLayout: ProjectTabLayoutSummary | null | undefined;
  workspaceSelection: WorkspaceSelection;
}) {
  const validMobileGroupIds = useMemo(
    () =>
      new Set(
        tabLayout?.projectId === selectedProjectId
          ? tabLayout.groups.map(({ id }) => id)
          : [],
      ),
    [selectedProjectId, tabLayout],
  );
  const activeMobileBottomTab = state.mobileBottomTabs.find(
    ({ id }) => id === state.activeMobileBottomTabId,
  );
  const mobileBottomNavigationItems: MobileBottomNavigationItem[] =
    state.mobileBottomTabs.map((tab) => {
      const group = tabLayout?.groups.find(({ id }) => id === tab.groupId);
      const tabKey = group
        ? (workspaceSelection.activeTabByGroup[group.id] ?? group.anchorTabKey)
        : null;
      return {
        id: tab.id,
        label: group?.title,
        removable: tab.id !== PRIMARY_MOBILE_BOTTOM_TAB_ID,
        surface: tabKey ? projectSurfaceIndex.byTabKey.get(tabKey) : undefined,
      };
    });
  return {
    activeMobileBottomTab,
    mobileBottomNavigationItems,
    validMobileGroupIds,
  } as const;
}

export function useMobileProjectNavigationEffects({
  compactShell,
  model,
  refs,
  saveMobileBottomTabs,
  selectedProjectId,
  settings,
  state,
  tabLayout,
  workspaceSelection,
}: {
  compactShell: boolean;
  model: ReturnType<typeof useMobileProjectNavigationModel>;
  refs: MobileProjectNavigationRefs;
  saveMobileBottomTabs: ReturnType<typeof useMobileBottomTabsPersistence>;
  selectedProjectId: string | null;
  settings: {
    data:
      | {
          preferences: {
            mobileProjectTabConfigurations: Record<
              string,
              (string | null)[] | undefined
            >;
          };
        }
      | undefined;
    isSuccess: boolean;
  };
  state: MobileProjectNavigationState;
  tabLayout: ProjectTabLayoutSummary | null | undefined;
  workspaceSelection: WorkspaceSelection;
}) {
  useEffect(() => {
    if (!selectedProjectId) {
      if (state.mobileBottomTabsProjectId !== null) {
        resetMobileProjectNavigation(state, refs);
      }
      return;
    }
    if (
      state.mobileBottomTabsProjectId === selectedProjectId ||
      !settings.data
    ) {
      return;
    }
    const restored = mobileBottomTabsFromConfiguration(
      settings.data.preferences.mobileProjectTabConfigurations[
        selectedProjectId
      ],
    );
    refs.mobileBottomTabSequenceRef.current = restored.length - 1;
    refs.persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature: JSON.stringify(mobileBottomTabConfiguration(restored)),
    };
    state.setMobileBottomTabs(restored);
    state.setMobileBottomTabsProjectId(selectedProjectId);
    state.setActiveMobileBottomTabId(PRIMARY_MOBILE_BOTTOM_TAB_ID);
    state.setMobileTabGridOpen(false);
  }, [state.mobileBottomTabsProjectId, selectedProjectId, settings.data]);

  useEffect(() => {
    if (
      !compactShell ||
      !selectedProjectId ||
      state.mobileBottomTabsProjectId !== selectedProjectId ||
      !settings.isSuccess
    ) {
      return;
    }
    const groupIds = mobileBottomTabConfiguration(state.mobileBottomTabs);
    const signature = JSON.stringify(groupIds);
    if (
      refs.persistedMobileBottomTabsRef.current?.projectId ===
        selectedProjectId &&
      refs.persistedMobileBottomTabsRef.current.signature === signature
    ) {
      return;
    }
    refs.persistedMobileBottomTabsRef.current = {
      projectId: selectedProjectId,
      signature,
    };
    saveMobileBottomTabs.mutate({ groupIds, projectId: selectedProjectId });
  }, [
    compactShell,
    state.mobileBottomTabs,
    state.mobileBottomTabsProjectId,
    selectedProjectId,
    settings.isSuccess,
  ]);

  useEffect(() => {
    if (!compactShell) {
      state.setMobileTabGridOpen(false);
      return;
    }
    if (
      state.mobileTabGridOpen ||
      workspaceSelection.destination !== "surface" ||
      !workspaceSelection.selectedGroupId ||
      tabLayout?.projectId !== selectedProjectId
    ) {
      return;
    }
    state.setMobileBottomTabs((current) =>
      assignMobileBottomTab(
        current,
        state.activeMobileBottomTabId,
        workspaceSelection.selectedGroupId!,
      ),
    );
  }, [
    state.activeMobileBottomTabId,
    compactShell,
    state.mobileTabGridOpen,
    selectedProjectId,
    tabLayout?.projectId,
    workspaceSelection.destination,
    workspaceSelection.selectedGroupId,
  ]);

  useEffect(() => {
    if (!compactShell || tabLayout?.projectId !== selectedProjectId) return;
    const activeTab = state.mobileBottomTabs.find(
      ({ id }) => id === state.activeMobileBottomTabId,
    );
    if (
      activeTab?.groupId &&
      !model.validMobileGroupIds.has(activeTab.groupId)
    ) {
      state.setMobileTabGridOpen(true);
    }
    state.setMobileBottomTabs((current) =>
      reconcileMobileBottomTabs(current, model.validMobileGroupIds),
    );
  }, [
    state.activeMobileBottomTabId,
    compactShell,
    state.mobileBottomTabs,
    selectedProjectId,
    tabLayout?.projectId,
    model.validMobileGroupIds,
  ]);
}

export function createMobileProjectNavigationCommands({
  refs,
  selectGroup,
  selectedProjectId,
  setWorkspaceSelection,
  state,
}: {
  refs: MobileProjectNavigationRefs;
  selectGroup(groupId: string): void;
  selectedProjectId: string | null;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  state: MobileProjectNavigationState;
}) {
  const selectMobileOverview = () => {
    state.setMobileTabGridOpen(false);
    setWorkspaceSelection((current) =>
      selectWorkspaceOverview(current, selectedProjectId),
    );
  };
  const selectMobileBottomTab = (tabId: string) => {
    state.setActiveMobileBottomTabId(tabId);
    const tab = state.mobileBottomTabs.find(({ id }) => id === tabId);
    if (!tab?.groupId) {
      state.setMobileTabGridOpen(true);
      return;
    }
    state.setMobileTabGridOpen(false);
    selectGroup(tab.groupId);
  };
  const openMobileBottomTabSwitcher = (tabId: string) => {
    state.setActiveMobileBottomTabId(tabId);
    state.setMobileTabGridOpen(true);
  };
  const addMobileBottomTab = () => {
    const tabId = `mobile-${++refs.mobileBottomTabSequenceRef.current}`;
    state.setMobileBottomTabs((current) => [
      ...current,
      { groupId: null, id: tabId },
    ]);
    state.setActiveMobileBottomTabId(tabId);
    state.setMobileTabGridOpen(true);
  };
  const selectGroupFromMobileSwitcher = (groupId: string) => {
    state.setMobileBottomTabs((current) =>
      assignMobileBottomTab(current, state.activeMobileBottomTabId, groupId),
    );
    state.setMobileTabGridOpen(false);
    selectGroup(groupId);
  };
  const removeMobileBottomTabById = (tabId: string) => {
    const removal = removeMobileBottomTab(state.mobileBottomTabs, tabId);
    if (!removal) return;
    state.setMobileBottomTabs(removal.tabs);
    if (tabId !== state.activeMobileBottomTabId) return;
    state.setActiveMobileBottomTabId(removal.activeTabId);
    const next = removal.tabs.find(({ id }) => id === removal.activeTabId);
    if (next?.groupId) {
      state.setMobileTabGridOpen(false);
      selectGroup(next.groupId);
    } else {
      state.setMobileTabGridOpen(true);
    }
  };
  return {
    addMobileBottomTab,
    openMobileBottomTabSwitcher,
    removeActiveMobileBottomTab: () =>
      removeMobileBottomTabById(state.activeMobileBottomTabId),
    removeMobileBottomTabById,
    selectGroupFromMobileSwitcher,
    selectMobileBottomTab,
    selectMobileOverview,
  } as const;
}
