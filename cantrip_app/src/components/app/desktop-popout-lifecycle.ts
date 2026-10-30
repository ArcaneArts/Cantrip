import { workspacePaneViews } from "@cantrip/protocol";
import type {
  ProjectSummary,
  ProjectTabLayoutSummary,
  WorkspaceOwnership,
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
import { getExplorers } from "@/lib/api";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import {
  closeCurrentDesktopWindow,
  discoverDesktopPopoutPaneIds,
  focusDesktopPopoutPane,
  openDesktopProjectOverviewPopout,
  updateDesktopWindowTitle,
  watchDesktopPopoutPane,
  type DesktopPopoutPaneTarget,
  type DesktopProjectOverviewTarget,
} from "@/lib/desktop-popout";
import { errorMessage as errorText } from "@/lib/error-message";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";
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

export function useDesktopPopoutModel({
  detachOwnedPane,
  activeProjectOverviewSection,
  currentSurface,
  desktopRuntime,
  detached,
  explorerLifecycleRef,
  isPopout,
  projectOverviewSelected,
  queryClient,
  resolvedProjectOverviewWorktreeId,
  selectedProject,
  selectedProjectId,
  selectedPaneId,
  status,
}: {
  detachOwnedPane?(
    paneId: string,
    title: string,
    tabId?: string,
  ): Promise<unknown>;
  activeProjectOverviewSection: ProjectOverviewSection;
  currentSurface: { tabKey: string; title: string } | null;
  desktopRuntime: boolean;
  detached: DetachedDesktopPaneState;
  explorerLifecycleRef: MutableRefObject<Map<string, ExplorerLifecycleActions>>;
  isPopout: boolean;
  projectOverviewSelected: boolean;
  queryClient: QueryClient;
  resolvedProjectOverviewWorktreeId: string | null;
  selectedProject: ProjectSummary | undefined;
  selectedProjectId: string | null;
  selectedPaneId: string | null;
  status: DesktopPopoutStatusState;
}) {
  const ownedTransferPending = useRef(false);
  const activePopout =
    desktopRuntime &&
    detachOwnedPane &&
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
      !detachOwnedPane &&
      !isPopout &&
      desktopRuntime &&
      (detached.claims.has(paneId) || !detached.inspectedPaneIds.has(paneId)),
    [
      desktopRuntime,
      detached.claims,
      detached.inspectedPaneIds,
      isPopout,
      detachOwnedPane,
    ],
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
  const startOwnedTransfer = (
    paneId: string,
    title: string,
    tabId?: string,
  ) => {
    if (
      !detachOwnedPane ||
      status.popoutPending ||
      ownedTransferPending.current
    )
      return;
    // UI state updates on the next render; claim synchronously so menu and
    // header actions in the same event batch cannot create overlapping moves.
    ownedTransferPending.current = true;
    status.setPopoutPending(true);
    status.setPopoutError(null);
    void (async () => {
      try {
        if (tabId === undefined) await detachOwnedPane(paneId, title);
        else await detachOwnedPane(paneId, title, tabId);
      } catch (error) {
        status.setPopoutError(errorText(error));
      } finally {
        ownedTransferPending.current = false;
        status.setPopoutPending(false);
      }
    })();
  };
  const popOutTab =
    desktopRuntime && detachOwnedPane
      ? (surface: { paneId: string; tabKey: string; title: string }) => {
          startOwnedTransfer(surface.paneId, surface.title, surface.tabKey);
        }
      : undefined;
  const popOutPane =
    desktopRuntime && detachOwnedPane
      ? (surface: { paneId: string; title: string }) => {
          startOwnedTransfer(surface.paneId, surface.title);
        }
      : undefined;
  const popOutActiveView = () => {
    if (!activePopout || status.popoutPending) return;
    // Opening a view always uses the revisioned transfer handshake. Missing
    // workspace authority must never fall back to a legacy local pane claim.
    startOwnedTransfer(
      activePopout.target.paneId,
      activePopout.title,
      activePopout.target.activeTabKey,
    );
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
    popOutTab,
    popOutPane,
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
          // Observer failure is not evidence that the native owner closed.
          // Keep its claim until destruction or a successful native lookup.
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
  ownership,
}: {
  isLayoutMutationPending: boolean;
  layout: ProjectTabLayoutSummary | null | undefined;
  layoutIsSuccess: boolean;
  popoutTarget: DesktopPopoutPaneTarget | null;
  /** null means ownership is still loading; undefined is legacy-only callers. */
  ownership?: { layout: WorkspaceOwnership; windowId: string } | null;
}) {
  const usesOwnership = ownership !== undefined;
  const owned = ownership?.layout;
  const windowId = ownership?.windowId;
  useEffect(() => {
    if (!popoutTarget || !layoutIsSuccess || isLayoutMutationPending) return;
    if (usesOwnership) {
      if (!owned || !windowId || owned.projectId !== popoutTarget.projectId)
        return;
      if (windowId === owned.mainWindowId) return;
      if (
        owned.pendingTransfers?.some(
          (transfer) =>
            transfer.destinationWindowId === windowId ||
            transfer.sourceWindowId === windowId,
        )
      )
        return;
      // A popout may have been split or rearranged since its launch URL was
      // created. Its original pane is not the lifetime of the native window.
      if (
        owned.windows
          .find(({ id }) => id === windowId)
          ?.panes.some((pane) => workspacePaneViews(pane).length > 0)
      )
        return;
    } else if (layout?.panes.some(({ id }) => id === popoutTarget.paneId))
      return;
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
  }, [
    popoutTarget,
    layout,
    layoutIsSuccess,
    isLayoutMutationPending,
    usesOwnership,
    owned,
    windowId,
  ]);
}

export function createDesktopPaneSelectionCommands({
  desktopRuntime,
  detached,
  isPopout,
  layout,
  model,
  revealWorkspace,
  setPopoutError,
  setWorkspaceSelection,
}: {
  desktopRuntime: boolean;
  detached: DetachedDesktopPaneState;
  isPopout: boolean;
  layout: ProjectTabLayoutSummary | null | undefined;
  model: ReturnType<typeof useDesktopPopoutModel>;
  revealWorkspace(): void;
  setPopoutError(error: string | null): void;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
}) {
  const selectPaneFromSidebar = (paneId: string) => {
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
      .catch((error: unknown) => setPopoutError(errorText(error)));
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
