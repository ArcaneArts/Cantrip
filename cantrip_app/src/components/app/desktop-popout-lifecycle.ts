import type {
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import { projectOverviewSectionLabel } from "@/components/app/application-shell-model";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { prepareExplorerPopout as prepareExplorerPopoutLifecycle } from "@/components/explorer/explorer-lifecycle";
import { getExplorers } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  closeCurrentDesktopWindow,
  discoverDesktopPopoutPaneIds,
  focusDesktopPopoutPane,
  openDesktopPopoutPane,
  openDesktopProjectOverviewPopout,
  updateDesktopWindowTitle,
  watchDesktopPopoutPane,
  type DesktopPopoutPaneTarget,
  type DesktopProjectOverviewTarget,
} from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";
import type { SidebarFilePreviewState } from "@/lib/sidebar-file-tabs";
import {
  selectWorkspacePane,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";
import type { DetachedDesktopPaneState } from "@/components/app/detached-pane-ownership";
export { useDetachedDesktopPaneState } from "@/components/app/detached-pane-ownership";

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

export async function openOwnedDesktopPane({
  claim,
  complete,
  open = openDesktopPopoutPane,
  release,
  target,
  title,
}: {
  claim(): void;
  complete(): void;
  open?: typeof openDesktopPopoutPane;
  release(): void;
  target: DesktopPopoutPaneTarget;
  title: string;
}) {
  flushSync(claim);
  try {
    const disposition = await open(target, title);
    complete();
    return disposition;
  } catch (error) {
    release();
    throw error;
  }
}

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
  selectedPaneId,
  status,
}: {
  activeProjectOverviewSection: ProjectOverviewSection;
  currentSurface: { tabKey: string; title: string } | null;
  desktopRuntime: boolean;
  detached: DetachedDesktopPaneState;
  explorerLifecycleRef: MutableRefObject<Map<string, ExplorerLifecycleActions>>;
  isPopout: boolean;
  projectOverviewSelected: boolean;
  queryClient: QueryClient;
  resolvedProjectOverviewWorktreeId: string | null;
  selectedExplorer: ExplorerSummary | undefined;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedPaneId: string | null;
  status: DesktopPopoutStatusState;
}) {
  const activePopout =
    desktopRuntime &&
    !isPopout &&
    currentSurface &&
    selectedProject &&
    selectedPaneId
      ? {
          target: {
            activeTabKey: currentSurface.tabKey,
            paneId: selectedPaneId,
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
  const paneOwnedElsewhere = useCallback(
    (paneId: string) =>
      !isPopout &&
      desktopRuntime &&
      (detached.claims.has(paneId) || !detached.inspectedPaneIds.has(paneId)),
    [desktopRuntime, detached.claims, detached.inspectedPaneIds, isPopout],
  );
  const selectedPaneOwnedElsewhere = Boolean(
    selectedPaneId && paneOwnedElsewhere(selectedPaneId),
  );
  const resumeDetachedPane = useCallback(
    async (paneId: string) => {
      const claim = detached.claims.get(paneId);
      const explorerId = claim?.explorerId ?? null;
      const projectId = claim?.projectId ?? null;
      try {
        if (explorerId && projectId) {
          const refreshed = await getExplorers(projectId);
          queryClient.setQueryData(["explorers", projectId], refreshed);
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
        detached.releasePane(paneId);
      }
    },
    [detached.claims, detached.releasePane, explorerLifecycleRef, queryClient],
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
        await openOwnedDesktopPane({
          claim: () =>
            detached.claimPane(
              activePopout.target.paneId,
              activePopout.target.projectId,
              selectedExplorer?.id ?? null,
            ),
          complete: () =>
            detached.completePaneClaim(activePopout.target.paneId),
          release: () => detached.releasePane(activePopout.target.paneId),
          target: activePopout.target,
          title: activePopout.title,
        });
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
    selectedPaneOwnedElsewhere,
    paneOwnedElsewhere,
    popOutActiveView,
    popOutProjectOverviewView,
    resumeDetachedPane,
  } as const;
}

export function useDesktopPopoutEffects({
  currentSurface,
  desktopRuntime,
  detached,
  isPopout,
  layoutPaneIds = [],
  model,
  projectOverviewPopoutTarget,
  selectedProject,
}: {
  currentSurface: { tabKey: string; title: string } | null;
  desktopRuntime: boolean;
  detached: DetachedDesktopPaneState;
  isPopout: boolean;
  model: ReturnType<typeof useDesktopPopoutModel>;
  projectOverviewPopoutTarget: DesktopProjectOverviewTarget | null;
  selectedProject: ProjectSummary | undefined;
  layoutPaneIds?: readonly string[];
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
    if (!desktopRuntime || isPopout || layoutPaneIds.length === 0) return;
    let mounted = true;
    void discoverDesktopPopoutPaneIds(layoutPaneIds)
      .then((discovered) => {
        if (mounted && selectedProject) {
          detached.reconcileDiscovery(
            selectedProject.id,
            layoutPaneIds,
            discovered,
          );
        }
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        clientLogger.warn("Desktop pop-out discovery failed", {
          ...operationalErrorMetadata(error),
          event: "window.popout.discovery.failed",
          operation: "discover-windows",
          reasonCode: "native-window-error",
          status: "recovering",
          subsystem: "desktop-window",
        });
      });
    return () => {
      mounted = false;
    };
  }, [
    desktopRuntime,
    detached.reconcileDiscovery,
    isPopout,
    layoutPaneIds.join("\0"),
    selectedProject?.id,
  ]);

  const ownedPaneKey = [...detached.claims]
    .filter(([, claim]) => claim.phase === "detached")
    .map(([paneId]) => paneId)
    .sort()
    .join("\0");
  useEffect(() => {
    if (!desktopRuntime || isPopout || ownedPaneKey.length === 0) return;
    let mounted = true;
    const stopObservers: Array<() => void> = [];
    for (const [paneId, claim] of detached.claims) {
      if (claim.phase !== "detached") continue;
      const resumeLocally = () => {
        if (mounted) void model.resumeDetachedPane(paneId);
      };
      void watchDesktopPopoutPane(paneId, resumeLocally)
        .then((stop) => {
          if (mounted) stopObservers.push(stop);
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
            surfaceId: paneId,
          });
          resumeLocally();
        });
    }
    return () => {
      mounted = false;
      for (const stop of stopObservers) stop();
    };
  }, [desktopRuntime, isPopout, model.resumeDetachedPane, ownedPaneKey]);
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
  popoutTarget: DesktopPopoutPaneTarget | null;
}) {
  useEffect(() => {
    if (!popoutTarget || !layoutIsSuccess || isLayoutMutationPending) return;
    if (layout?.panes.some(({ id }) => id === popoutTarget.paneId)) return;
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

export function createDesktopPaneSelectionCommands({
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
  detached: DetachedDesktopPaneState;
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
  const selectPaneFromSidebar = (paneId: string) => {
    setSidebarFilePreview((current) =>
      current ? { ...current, active: false } : null,
    );
    if (!layout) return;
    const selectLocally = () => {
      setWorkspaceSelection((current) =>
        selectWorkspacePane(current, layout, paneId),
      );
      revealWorkspace();
    };
    if (!desktopRuntime || isPopout) {
      selectLocally();
      return;
    }
    if (!model.paneOwnedElsewhere(paneId)) {
      selectLocally();
      return;
    }
    void focusDesktopPopoutPane(paneId)
      .then((focused) => {
        if (focused) {
          setWorkspaceSelection((current) =>
            selectWorkspacePane(current, layout, paneId),
          );
          revealWorkspace();
        } else {
          void model.resumeDetachedPane(paneId);
          selectLocally();
        }
      })
      .catch(() => selectLocally());
  };
  const focusDetachedPane = (paneId: string) => {
    void focusDesktopPopoutPane(paneId)
      .then((focused) => {
        if (!focused) void model.resumeDetachedPane(paneId);
      })
      .catch((error: unknown) => setPopoutError(errorText(error)));
  };
  return { focusDetachedPane, selectPaneFromSidebar } as const;
}
