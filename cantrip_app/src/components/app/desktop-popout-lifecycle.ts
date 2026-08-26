import type {
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { projectOverviewSectionLabel } from "@/components/app/application-shell-model";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { prepareExplorerPopout as prepareExplorerPopoutLifecycle } from "@/components/explorer/explorer-lifecycle";
import { getExplorers } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  closeCurrentDesktopWindow,
  focusDesktopPopoutGroup,
  openDesktopPopoutGroup,
  openDesktopProjectOverviewPopout,
  updateDesktopWindowTitle,
  watchDesktopPopoutGroup,
  type DesktopPopoutGroupTarget,
  type DesktopProjectOverviewTarget,
} from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";
import type { SidebarFilePreviewState } from "@/lib/sidebar-file-tabs";
import {
  selectWorkspaceGroup,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

export function useDesktopPopoutStatusState() {
  const [popoutPending, setPopoutPending] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);
  return {
    popoutError,
    popoutPending,
    setPopoutError,
    setPopoutPending,
  } as const;
}

type DesktopPopoutStatusState = ReturnType<typeof useDesktopPopoutStatusState>;

export function useDetachedDesktopGroupState() {
  const [detachedGroupId, setDetachedGroupId] = useState<string | null>(null);
  const detachedExplorerIdRef = useRef<string | null>(null);
  return {
    detachedExplorerIdRef,
    detachedGroupId,
    setDetachedGroupId,
  } as const;
}

type DetachedDesktopGroupState = ReturnType<
  typeof useDetachedDesktopGroupState
>;

export function useDesktopPopoutModel({
  activeProjectOverviewSection,
  currentSurface,
  desktopRuntime,
  detached,
  explorerLifecycleRef,
  isPopout,
  projectOverviewSelected,
  queryClient,
  resolvedProjectOverviewWorktreeId,
  selectedExplorer,
  selectedProject,
  selectedProjectId,
  selectedTabGroupId,
  status,
}: {
  activeProjectOverviewSection: ProjectOverviewSection;
  currentSurface: { tabKey: string; title: string } | null;
  desktopRuntime: boolean;
  detached: DetachedDesktopGroupState;
  explorerLifecycleRef: MutableRefObject<Map<string, ExplorerLifecycleActions>>;
  isPopout: boolean;
  projectOverviewSelected: boolean;
  queryClient: QueryClient;
  resolvedProjectOverviewWorktreeId: string | null;
  selectedExplorer: ExplorerSummary | undefined;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedTabGroupId: string | null;
  status: DesktopPopoutStatusState;
}) {
  const activePopout =
    desktopRuntime &&
    !isPopout &&
    currentSurface &&
    selectedProject &&
    selectedTabGroupId
      ? {
          target: {
            activeTabKey: currentSurface.tabKey,
            groupId: selectedTabGroupId,
            projectId: selectedProject.id,
          },
          title: currentSurface.title,
        }
      : null;
  const activeProjectOverviewPopout =
    desktopRuntime && !isPopout && projectOverviewSelected && selectedProject
      ? {
          target: {
            projectId: selectedProject.id,
            section: activeProjectOverviewSection,
            worktreeId:
              activeProjectOverviewSection === "overview" ||
              activeProjectOverviewSection === "tasks"
                ? null
                : resolvedProjectOverviewWorktreeId,
          } satisfies DesktopProjectOverviewTarget,
          title: `${selectedProject.name} · ${projectOverviewSectionLabel(activeProjectOverviewSection)}`,
        }
      : null;
  const groupOwnedElsewhere =
    !isPopout &&
    detached.detachedGroupId !== null &&
    detached.detachedGroupId === selectedTabGroupId;
  const resumeDetachedGroup = useCallback(
    async (groupId: string) => {
      const explorerId = detached.detachedExplorerIdRef.current;
      try {
        if (explorerId && selectedProjectId) {
          const refreshed = await getExplorers(selectedProjectId);
          queryClient.setQueryData(["explorers", selectedProjectId], refreshed);
          const persisted = refreshed.find(({ id }) => id === explorerId);
          const lifecycle = explorerLifecycleRef.current.get(explorerId);
          if (persisted && lifecycle) {
            await lifecycle.reconcile(persisted);
          } else {
            await queryClient.invalidateQueries({
              queryKey: ["explorer-file", explorerId],
            });
          }
        }
      } catch (error) {
        clientLogger.warn("Explorer state recovery after pop-out failed", {
          ...operationalErrorMetadata(error),
          event: "surface.explorer.popout-recovery.failed",
          operation: "recover-state",
          reasonCode: "refresh-failed",
          status: "failed",
          subsystem: "explorer",
          surfaceId: explorerId ?? undefined,
        });
      } finally {
        detached.detachedExplorerIdRef.current = null;
        detached.setDetachedGroupId((current) =>
          current === groupId ? null : current,
        );
      }
    },
    [queryClient, selectedProjectId],
  );
  const popOutActiveView = () => {
    if (!activePopout || status.popoutPending) return;
    void (async () => {
      const startedAt = performance.now();
      clientLogger.info("Desktop pop-out preparation started", {
        event: "window.popout.open.started",
        operation: "open-popout",
        projectId: activePopout.target.projectId,
        subsystem: "desktop-window",
      });
      const explorerLifecycle = selectedExplorer
        ? explorerLifecycleRef.current.get(selectedExplorer.id)
        : null;
      const preparation = await prepareExplorerPopoutLifecycle(
        explorerLifecycle,
        () =>
          window.confirm(
            "This Explorer has unsaved changes. Save and continue opening it in a new window?\n\nChoose Cancel to keep editing in this window.",
          ),
      );
      if (preparation === "cancelled") return;
      if (preparation === "save-failed") {
        status.setPopoutError(
          "Save the Explorer file before opening a pop-out.",
        );
        return;
      }
      if (preparation === "state-failed") {
        status.setPopoutError(
          "Explorer view state could not be saved before opening the pop-out.",
        );
        return;
      }
      status.setPopoutPending(true);
      status.setPopoutError(null);
      try {
        await openDesktopPopoutGroup(activePopout.target, activePopout.title);
        detached.detachedExplorerIdRef.current = selectedExplorer?.id ?? null;
        detached.setDetachedGroupId(activePopout.target.groupId);
        clientLogger.info("Desktop pop-out opened", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "window.popout.open.completed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          status: "opened",
          subsystem: "desktop-window",
        });
      } catch (error) {
        clientLogger.error("Desktop pop-out failed to open", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "window.popout.open.failed",
          operation: "open-popout",
          projectId: activePopout.target.projectId,
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
        status.setPopoutError(errorText(error));
      } finally {
        status.setPopoutPending(false);
      }
    })();
  };
  const popOutProjectOverviewView = () => {
    if (!activeProjectOverviewPopout || status.popoutPending) return;
    void (async () => {
      const startedAt = performance.now();
      status.setPopoutPending(true);
      status.setPopoutError(null);
      try {
        await openDesktopProjectOverviewPopout(
          activeProjectOverviewPopout.target,
          activeProjectOverviewPopout.title,
        );
        clientLogger.info("Project overview pop-out opened", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "window.project-overview-popout.open.completed",
          operation: "open-popout",
          projectId: activeProjectOverviewPopout.target.projectId,
          status: "opened",
          subsystem: "desktop-window",
        });
      } catch (error) {
        clientLogger.error("Project overview pop-out failed to open", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "window.project-overview-popout.open.failed",
          operation: "open-popout",
          projectId: activeProjectOverviewPopout.target.projectId,
          reasonCode: "native-window-error",
          status: "failed",
          subsystem: "desktop-window",
        });
        status.setPopoutError(errorText(error));
      } finally {
        status.setPopoutPending(false);
      }
    })();
  };
  return {
    activePopout,
    activeProjectOverviewPopout,
    groupOwnedElsewhere,
    popOutActiveView,
    popOutProjectOverviewView,
    resumeDetachedGroup,
  } as const;
}

export function useDesktopPopoutEffects({
  currentSurface,
  desktopRuntime,
  detached,
  isPopout,
  model,
  projectOverviewPopoutTarget,
  selectedProject,
}: {
  currentSurface: { tabKey: string; title: string } | null;
  desktopRuntime: boolean;
  detached: DetachedDesktopGroupState;
  isPopout: boolean;
  model: ReturnType<typeof useDesktopPopoutModel>;
  projectOverviewPopoutTarget: DesktopProjectOverviewTarget | null;
  selectedProject: ProjectSummary | undefined;
}) {
  useEffect(() => {
    const popoutContentTitle =
      currentSurface?.title ??
      (projectOverviewPopoutTarget
        ? projectOverviewSectionLabel(projectOverviewPopoutTarget.section)
        : null);
    if (!isPopout || !popoutContentTitle) return;
    const projectTitle =
      selectedProject?.github?.nameWithOwner ?? selectedProject?.name;
    const title = [popoutContentTitle, projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(title).catch((error: unknown) => {
      clientLogger.warn("Desktop pop-out title update failed", {
        ...operationalErrorMetadata(error),
        event: "window.popout.title.failed",
        operation: "set-title",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [currentSurface, isPopout, projectOverviewPopoutTarget, selectedProject]);

  useEffect(() => {
    if (!desktopRuntime || isPopout || !detached.detachedGroupId) return;
    const observedGroupId = detached.detachedGroupId;
    let mounted = true;
    let stopObserving: (() => void) | null = null;
    const resumeLocally = () => {
      if (!mounted) return;
      void model.resumeDetachedGroup(observedGroupId);
    };
    void watchDesktopPopoutGroup(observedGroupId, resumeLocally)
      .then((stop) => {
        if (mounted) stopObserving = stop;
        else stop();
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        clientLogger.warn("Desktop pop-out observer failed", {
          ...operationalErrorMetadata(error),
          event: "window.popout.observe.failed",
          operation: "observe-window",
          reasonCode: "native-window-error",
          status: "recovering",
          subsystem: "desktop-window",
        });
        resumeLocally();
      });
    return () => {
      mounted = false;
      stopObserving?.();
    };
  }, [
    desktopRuntime,
    detached.detachedGroupId,
    isPopout,
    model.resumeDetachedGroup,
  ]);
}

export function useOrphanedDesktopPopoutEffect({
  isLayoutMutationPending,
  layout,
  layoutIsSuccess,
  popoutTarget,
}: {
  isLayoutMutationPending: boolean;
  layout: ProjectTabLayoutSummary | null | undefined;
  layoutIsSuccess: boolean;
  popoutTarget: DesktopPopoutGroupTarget | null;
}) {
  useEffect(() => {
    if (!popoutTarget || !layoutIsSuccess || isLayoutMutationPending) return;
    if (layout?.groups.some(({ id }) => id === popoutTarget.groupId)) return;
    void closeCurrentDesktopWindow().catch((error: unknown) => {
      clientLogger.warn("Orphaned desktop pop-out failed to close", {
        ...operationalErrorMetadata(error),
        event: "window.popout.close.failed",
        operation: "close-popout",
        reasonCode: "native-window-error",
        status: "failed",
        subsystem: "desktop-window",
      });
    });
  }, [popoutTarget, layout, layoutIsSuccess, isLayoutMutationPending]);
}

export function createDesktopGroupSelectionCommands({
  desktopRuntime,
  detached,
  isPopout,
  layout,
  model,
  revealWorkspace,
  setPopoutError,
  setSidebarFilePreview,
  setWorkspaceSelection,
}: {
  desktopRuntime: boolean;
  detached: DetachedDesktopGroupState;
  isPopout: boolean;
  layout: ProjectTabLayoutSummary | null | undefined;
  model: ReturnType<typeof useDesktopPopoutModel>;
  revealWorkspace(): void;
  setPopoutError(error: string | null): void;
  setSidebarFilePreview: Dispatch<
    SetStateAction<SidebarFilePreviewState | null>
  >;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
}) {
  const selectGroupFromSidebar = (groupId: string) => {
    setSidebarFilePreview((current) =>
      current ? { ...current, active: false } : null,
    );
    if (!layout) return;
    const selectLocally = () => {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, layout, groupId),
      );
      detached.setDetachedGroupId(null);
      revealWorkspace();
    };
    if (!desktopRuntime || isPopout) {
      selectLocally();
      return;
    }
    void focusDesktopPopoutGroup(groupId)
      .then((focused) => {
        if (focused) {
          setWorkspaceSelection((current) =>
            selectWorkspaceGroup(current, layout, groupId),
          );
          detached.setDetachedGroupId(groupId);
          revealWorkspace();
        } else {
          selectLocally();
        }
      })
      .catch(() => selectLocally());
  };
  const focusDetachedGroup = (groupId: string) => {
    void focusDesktopPopoutGroup(groupId)
      .then((focused) => {
        if (!focused) void model.resumeDetachedGroup(groupId);
      })
      .catch((error: unknown) => setPopoutError(errorText(error)));
  };
  return { focusDetachedGroup, selectGroupFromSidebar } as const;
}
