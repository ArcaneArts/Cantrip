import type {
  ExecutionTarget,
  ExplorerEntry,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  TabGroupSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type { SidebarFilePinHandoffState } from "@/components/app/application-shell-model";
import type {
  ExplorerLifecycleRefs,
  SidebarExplorerMutations,
  SidebarFileState,
} from "@/components/app/sidebar-explorer-controller";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import { confirmExplorerDiscard } from "@/components/explorer/explorer-lifecycle";
import type { ExplorerFileMutationAuthorization } from "@/components/sidebar/project-sidebar-file-tree";
import {
  deleteExplorerEntry,
  renameExplorerEntry,
  updateExplorerViewState,
} from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { errorMessage as errorText } from "@/lib/error-message";
import {
  explorerFileIntentContext,
  recordExplorerFileIntent,
} from "@/lib/explorer-lifecycle-trace";
import {
  moveSidebarPath,
  pinnedExplorerForPath,
  sidebarExplorerCanOwnPreview,
  sidebarFilePreviewMatches,
  sidebarFileTargetGroupId,
  sidebarPathAtOrBelow,
} from "@/lib/sidebar-file-tabs";
import {
  selectWorkspaceGroup,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

interface MutationOperation<Input> {
  isPending?: boolean;
  mutate(input: Input): void;
  reset(): void;
}

function logSidebarFilePinPhase({
  explorer,
  phase,
  status,
  transactionId,
  ...details
}: {
  explorer: ExplorerSummary;
  phase: string;
  status: string;
  transactionId: string;
} & Record<string, unknown>): void {
  clientLogger.info("Explorer file pin handoff phase", {
    ...explorerFileIntentContext(explorer.id),
    ...details,
    event: "explorer.file.pin.phase",
    explorerId: explorer.id,
    operation: "pin-file",
    phase,
    projectId: explorer.projectId,
    status,
    subsystem: "explorer",
    transactionId,
    worktreeId: explorer.worktreeId,
  });
}

export function createSidebarExplorerCommands({
  abandonSidebarFilePinHandoff,
  createSidebarExplorerMutation,
  explorers,
  fileState,
  lifecycle,
  newGraphExplorer,
  newTerminal,
  openCreatedTab,
  pinSidebarFileMutation,
  projects,
  queryClient,
  revealWorkspace,
  selectedTabGroup,
  setDesktopSidebarDrawerOpen,
  setDetachedGroupId,
  setMobileTabGridOpen,
  setPopoutError,
  setWorkspaceSelection,
  sidebarExplorerCreationInput,
  sidebarExplorerCreationKey,
  tabLayout,
}: {
  abandonSidebarFilePinHandoff: (
    handoff: SidebarFilePinHandoffState,
    message?: string,
  ) => void;
  createSidebarExplorerMutation: SidebarExplorerMutations["createSidebarExplorerMutation"];
  explorers: ExplorerSummary[] | undefined;
  fileState: Pick<
    SidebarFileState,
    | "setSidebarFilePinHandoff"
    | "setSidebarFilePreview"
    | "sidebarFileWorkbenchReadyIdsRef"
    | "sidebarFilePinHandoffRef"
    | "sidebarFilePreview"
    | "waitForSidebarFileSuccessor"
  >;
  lifecycle: ExplorerLifecycleRefs;
  newGraphExplorer: MutationOperation<{
    entry: ExplorerEntry;
    explorer: ExplorerSummary;
    tabGroupId?: string;
  }>;
  newTerminal: MutationOperation<{
    directoryPath?: string;
    projectId: string;
    tabGroupId?: string;
    target?: ExecutionTarget;
    title?: string;
    worktreeId?: string;
  }>;
  openCreatedTab: (projectId: string, kind: "explorer", tabId: string) => void;
  pinSidebarFileMutation: SidebarExplorerMutations["pinSidebarFileMutation"];
  projects: ProjectSummary[] | undefined;
  queryClient: QueryClient;
  revealWorkspace: () => void;
  selectedTabGroup: TabGroupSummary | undefined;
  setDesktopSidebarDrawerOpen: (open: boolean) => void;
  setDetachedGroupId: (groupId: string | null) => void;
  setMobileTabGridOpen: (open: boolean) => void;
  setPopoutError: (error: string | null) => void;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  sidebarExplorerCreationInput: {
    projectId: string;
    worktreeId?: string;
  } | null;
  sidebarExplorerCreationKey: string | null;
  tabLayout: ProjectTabLayoutSummary | undefined;
}) {
  const {
    setSidebarFilePinHandoff,
    setSidebarFilePreview,
    sidebarFileWorkbenchReadyIdsRef,
    sidebarFilePinHandoffRef,
    sidebarFilePreview,
    waitForSidebarFileSuccessor,
  } = fileState;
  const {
    explorerLifecycleRef,
    sidebarExplorerCreationKeyRef,
    sidebarFilePreviewLifecycleRef,
  } = lifecycle;
  const sidebarFileGroupId = (explorer: ExplorerSummary): string | null => {
    return sidebarFileTargetGroupId({
      activeGroupId: selectedTabGroup?.id,
      explorerId: explorer.id,
      fallbackGroupId: tabLayout?.groups[0]?.id,
      preview: sidebarFilePreview,
    });
  };
  const focusPinnedSidebarFile = (explorer: ExplorerSummary) => {
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview(null);
    openCreatedTab(explorer.projectId, "explorer", explorer.id);
    setDesktopSidebarDrawerOpen(false);
  };
  const openSidebarFilePreview = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    if (entry.kind !== "file" || !entry.viewable) return;
    if (
      !sidebarExplorerCanOwnPreview({
        explorerId: explorer.id,
        layout: tabLayout,
        pinInProgress: Boolean(sidebarFilePinHandoffRef.current),
        workbenchReady: sidebarFileWorkbenchReadyIdsRef.current.has(
          explorer.id,
        ),
      })
    ) {
      clientLogger.info("Explorer file preview deferred for provisioning", {
        ...explorerFileIntentContext(explorer.id),
        event: "explorer.file.preview.deferred",
        explorerId: explorer.id,
        operation: "open-preview",
        projectId: explorer.projectId,
        reasonCode: sidebarFilePinHandoffRef.current
          ? "pin-handoff-in-progress"
          : !sidebarFileWorkbenchReadyIdsRef.current.has(explorer.id)
            ? "preview-owner-not-ready"
            : "preview-owner-is-tabbed",
        status: "deferred",
        subsystem: "explorer",
        worktreeId: explorer.worktreeId,
      });
      return;
    }
    recordExplorerFileIntent({
      actionKind: "open-preview",
      explorerId: explorer.id,
      projectId: explorer.projectId,
      samePath:
        sidebarFilePreview?.explorerId === explorer.id &&
        sidebarFilePreview.path === entry.path,
    });
    const pinned = pinnedExplorerForPath({
      explorers: explorers ?? [],
      layout: tabLayout,
      path: entry.path,
      worktreeId: explorer.worktreeId,
    });
    if (pinned) {
      focusPinnedSidebarFile(pinned);
      return;
    }
    const groupId = sidebarFileGroupId(explorer);
    if (
      sidebarFilePreviewMatches(sidebarFilePreview, {
        explorerId: explorer.id,
        groupId,
        path: entry.path,
        projectId: explorer.projectId,
      })
    ) {
      return;
    }
    const previewLifecycle = sidebarFilePreview
      ? sidebarFilePreviewLifecycleRef.current
      : (explorerLifecycleRef.current.get(explorer.id) ?? null);
    if (
      sidebarFilePreview?.path !== entry.path &&
      !confirmExplorerDiscard(previewLifecycle, () =>
        window.confirm(
          "Open another file and discard the unsaved changes in this preview?",
        ),
      )
    ) {
      return;
    }
    if (tabLayout && groupId) {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, tabLayout, groupId),
      );
    }
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview({
      active: true,
      explorerId: explorer.id,
      groupId,
      path: entry.path,
      projectId: explorer.projectId,
    });
    setDesktopSidebarDrawerOpen(false);
    setMobileTabGridOpen(false);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const pinSidebarFilePath = async (
    explorer: ExplorerSummary,
    path: string,
  ) => {
    const pinned = pinnedExplorerForPath({
      explorers: explorers ?? [],
      layout: tabLayout,
      path,
      worktreeId: explorer.worktreeId,
    });
    const currentHandoff = sidebarFilePinHandoffRef.current;
    const repeatedTransactionId =
      currentHandoff?.sourceExplorer.id === explorer.id &&
      currentHandoff.sourcePath === path
        ? currentHandoff.transactionId
        : undefined;
    const requestedTransactionId = repeatedTransactionId ?? crypto.randomUUID();
    recordExplorerFileIntent({
      actionKind: "pin-preview",
      explorerId: explorer.id,
      projectId: explorer.projectId,
      samePath:
        sidebarFilePreview?.explorerId === explorer.id &&
        sidebarFilePreview.path === path,
      transactionId: requestedTransactionId,
    });
    if (pinned) {
      logSidebarFilePinPhase({
        explorer,
        phase: "already-pinned",
        status: "completed",
        transactionId: requestedTransactionId,
      });
      focusPinnedSidebarFile(pinned);
      return;
    }
    if (currentHandoff) {
      // Double-click emits both click and double-click activity. Treat an
      // exact repeated pin as the same transaction and serialize other pins
      // until its destination either becomes ready or is abandoned.
      if (
        currentHandoff.sourceExplorer.id === explorer.id &&
        currentHandoff.sourcePath === path
      ) {
        logSidebarFilePinPhase({
          explorer,
          phase: "duplicate-request",
          reasonCode: "handoff-in-progress",
          status: "ignored",
          transactionId: currentHandoff.transactionId,
        });
        return;
      }
      logSidebarFilePinPhase({
        explorer,
        phase: "request-blocked",
        reasonCode: "another-handoff-in-progress",
        status: "ignored",
        transactionId: requestedTransactionId,
      });
      return;
    }
    if (
      !sidebarExplorerCanOwnPreview({
        explorerId: explorer.id,
        layout: tabLayout,
        pinInProgress: false,
        workbenchReady: sidebarFileWorkbenchReadyIdsRef.current.has(
          explorer.id,
        ),
      })
    ) {
      logSidebarFilePinPhase({
        explorer,
        phase: "request-blocked",
        reasonCode: !sidebarFileWorkbenchReadyIdsRef.current.has(explorer.id)
          ? "preview-owner-not-ready"
          : "preview-owner-is-tabbed",
        status: "ignored",
        transactionId: requestedTransactionId,
      });
      return;
    }
    const handoff: SidebarFilePinHandoffState = {
      destinationExplorer: null,
      destinationExplorerId: explorer.id,
      ready: false,
      sourceExplorer: explorer,
      sourcePath: path,
      transactionId: requestedTransactionId,
    };
    sidebarFilePinHandoffRef.current = handoff;
    setSidebarFilePinHandoff(handoff);
    logSidebarFilePinPhase({
      explorer,
      phase: "handoff-created",
      status: "completed",
      transactionId: handoff.transactionId,
    });
    const previewLifecycle =
      sidebarFilePreview?.explorerId === explorer.id &&
      sidebarFilePreview.path === path
        ? sidebarFilePreviewLifecycleRef.current
        : null;
    if (previewLifecycle?.dirty && !(await previewLifecycle.save())) {
      logSidebarFilePinPhase({
        dirty: true,
        explorer,
        phase: "preview-save",
        reasonCode: "save-failed",
        status: "failed",
        transactionId: handoff.transactionId,
      });
      if (
        sidebarFilePinHandoffRef.current?.transactionId ===
        handoff.transactionId
      ) {
        sidebarFilePinHandoffRef.current = null;
        setSidebarFilePinHandoff(null);
      }
      return;
    }
    if (
      sidebarFilePinHandoffRef.current?.transactionId !== handoff.transactionId
    ) {
      return;
    }
    const successor = await waitForSidebarFileSuccessor(explorer.id);
    if (
      sidebarFilePinHandoffRef.current?.transactionId !== handoff.transactionId
    ) {
      return;
    }
    if (!successor) {
      logSidebarFilePinPhase({
        explorer,
        phase: "successor-ready",
        reasonCode: "successor-readiness-timeout",
        status: "failed",
        transactionId: handoff.transactionId,
      });
      abandonSidebarFilePinHandoff(
        handoff,
        "The next editor did not become ready before pinning timed out.",
      );
      return;
    }
    logSidebarFilePinPhase({
      explorer,
      phase: "successor-ready",
      status: "completed",
      successorExplorerId: successor.id,
      transactionId: handoff.transactionId,
    });
    pinSidebarFileMutation.mutate({
      destinationExplorerId: handoff.destinationExplorerId,
      groupId: sidebarFileGroupId(explorer),
      path,
      transactionId: handoff.transactionId,
    });
    logSidebarFilePinPhase({
      explorer,
      phase: "mutation-dispatched",
      status: "completed",
      transactionId: handoff.transactionId,
    });
  };
  const pinSidebarFile = (explorer: ExplorerSummary, entry: ExplorerEntry) => {
    if (entry.kind !== "file" || !entry.viewable) return;
    void pinSidebarFilePath(explorer, entry.path);
  };
  const refreshSidebarExplorerEntries = async (explorer: ExplorerSummary) => {
    const relatedExplorerIds = (explorers ?? [])
      .filter((candidate) => candidate.worktreeId === explorer.worktreeId)
      .map((candidate) => candidate.id);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: [
          "explorer-directory",
          explorer.projectId,
          explorer.worktreeId,
        ],
      }),
      queryClient.invalidateQueries({
        queryKey: [
          "explorer-directory-commits",
          explorer.projectId,
          explorer.worktreeId,
        ],
      }),
      ...relatedExplorerIds.map((explorerId) =>
        queryClient.invalidateQueries({
          queryKey: ["explorer-file", explorerId],
        }),
      ),
      queryClient.invalidateQueries({
        exact: true,
        queryKey: ["worktree-status", explorer.projectId, explorer.worktreeId],
      }),
    ]);
  };
  const explorersDisplayingSidebarEntry = (
    explorer: ExplorerSummary,
    entryPath: string,
  ) =>
    (explorers ?? []).filter(
      (candidate) =>
        candidate.worktreeId === explorer.worktreeId &&
        candidate.selectedPath !== null &&
        sidebarPathAtOrBelow(candidate.selectedPath, entryPath),
    );
  const persistSidebarEntryPathChanges = async (
    candidates: ExplorerSummary[],
    previousPath: string,
    nextPath: string | null,
  ) => {
    const updates = await Promise.all(
      candidates.map((candidate) => {
        const selectedPath = nextPath
          ? moveSidebarPath(candidate.selectedPath!, previousPath, nextPath)
          : null;
        return updateExplorerViewState(candidate.id, {
          fileMode: selectedPath
            ? defaultExplorerFileMode(selectedPath)
            : "preview",
          selectedPath,
        });
      }),
    );
    for (const updated of updates) {
      queryClient.setQueryData<ExplorerSummary[]>(
        ["explorers", updated.projectId],
        (current = []) =>
          current.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
      );
      await explorerLifecycleRef.current.get(updated.id)?.reconcile(updated);
    }
  };
  const renameSidebarFileEntry = async (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    const displayedExplorers = explorersDisplayingSidebarEntry(
      explorer,
      entry.path,
    );
    for (const displayedExplorer of displayedExplorers) {
      if (!authorization.isCurrent()) {
        throw new Error("Explorer authorization changed. Try renaming again.");
      }
      const lifecycleActions = explorerLifecycleRef.current.get(
        displayedExplorer.id,
      );
      if (lifecycleActions?.dirty && !(await lifecycleActions.save())) {
        throw new Error("Save the open file before renaming it.");
      }
    }
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try renaming again.");
    }
    if (
      sidebarFilePreview?.explorerId === explorer.id &&
      sidebarPathAtOrBelow(sidebarFilePreview.path, entry.path) &&
      sidebarFilePreviewLifecycleRef.current?.dirty &&
      !(await sidebarFilePreviewLifecycleRef.current.save())
    ) {
      throw new Error("Save the open file before renaming it.");
    }
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try renaming again.");
    }
    const result = await renameExplorerEntry(explorer.id, {
      name,
      path: entry.path,
    });
    if (!authorization.isCurrent()) return;
    if (result.newPath) {
      await persistSidebarEntryPathChanges(
        displayedExplorers,
        result.path,
        result.newPath,
      ).catch((error: unknown) =>
        setPopoutError(
          `The entry was renamed, but an open file tab could not be updated: ${errorText(error)}`,
        ),
      );
      setSidebarFilePreview((current) =>
        current &&
        current.projectId === explorer.projectId &&
        sidebarPathAtOrBelow(current.path, result.path)
          ? {
              ...current,
              path: moveSidebarPath(current.path, result.path, result.newPath!),
            }
          : current,
      );
    }
    await refreshSidebarExplorerEntries(explorer);
  };
  const deleteSidebarFileEntry = async (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    const displayedExplorers = explorersDisplayingSidebarEntry(
      explorer,
      entry.path,
    );
    if (!authorization.isCurrent()) {
      throw new Error("Explorer authorization changed. Try deleting again.");
    }
    await deleteExplorerEntry(explorer.id, { path: entry.path });
    if (!authorization.isCurrent()) return;
    await persistSidebarEntryPathChanges(
      displayedExplorers,
      entry.path,
      null,
    ).catch((error: unknown) =>
      setPopoutError(
        `The entry was deleted, but an open file tab could not be updated: ${errorText(error)}`,
      ),
    );
    setSidebarFilePreview((current) => {
      if (
        !current ||
        current.projectId !== explorer.projectId ||
        !sidebarPathAtOrBelow(current.path, entry.path)
      ) {
        return current;
      }
      sidebarFilePreviewLifecycleRef.current = null;
      return null;
    });
    await refreshSidebarExplorerEntries(explorer);
  };
  const openSidebarFolderNative = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ) => {
    const project = (projects ?? []).find(
      (candidate) => candidate.id === explorer.projectId,
    );
    if (!project?.source) return;
    void revealProjectInNativeFileManager(
      project,
      localFolder,
      entry.path,
    ).catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openSidebarFolderTerminal = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    newTerminal.mutate({
      projectId: explorer.projectId,
      directoryPath: entry.path,
      tabGroupId: sidebarFileGroupId(explorer) ?? undefined,
      title: `Terminal · ${entry.name}`,
      target: {
        kind: "worktree",
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
      },
    });
  };
  const openSidebarFolderGraph = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    newGraphExplorer.mutate({
      explorer,
      entry,
      tabGroupId: sidebarFileGroupId(explorer) ?? undefined,
    });
  };
  const closeSidebarFilePreview = () => {
    if (
      !confirmExplorerDiscard(sidebarFilePreviewLifecycleRef.current, () =>
        window.confirm("Close this preview and discard its unsaved changes?"),
      )
    ) {
      return;
    }
    if (sidebarFilePreview) {
      recordExplorerFileIntent({
        actionKind: "close-preview",
        explorerId: sidebarFilePreview.explorerId,
        projectId: sidebarFilePreview.projectId,
        samePath: true,
      });
    }
    const handoff = sidebarFilePinHandoffRef.current;
    if (
      handoff &&
      sidebarFilePreview?.explorerId === handoff.sourceExplorer.id &&
      sidebarFilePreview.path === handoff.sourcePath
    ) {
      abandonSidebarFilePinHandoff(handoff);
    }
    sidebarFilePreviewLifecycleRef.current = null;
    setSidebarFilePreview(null);
  };
  const activateSidebarFilePreview = () => {
    if (!sidebarFilePreview) return;
    recordExplorerFileIntent({
      actionKind: "activate-preview",
      explorerId: sidebarFilePreview.explorerId,
      projectId: sidebarFilePreview.projectId,
      samePath: true,
    });
    if (sidebarFilePreview.active) return;
    if (tabLayout && sidebarFilePreview.groupId) {
      setWorkspaceSelection((current) =>
        selectWorkspaceGroup(current, tabLayout, sidebarFilePreview.groupId!),
      );
    }
    setSidebarFilePreview((current) =>
      current ? { ...current, active: true } : null,
    );
    setMobileTabGridOpen(false);
    setDetachedGroupId(null);
    revealWorkspace();
  };
  const retrySidebarFileTree = () => {
    createSidebarExplorerMutation.reset();
    sidebarExplorerCreationKeyRef.current = null;
    if (!sidebarExplorerCreationInput || !sidebarExplorerCreationKey) return;
    sidebarExplorerCreationKeyRef.current = sidebarExplorerCreationKey;
    createSidebarExplorerMutation.mutate(sidebarExplorerCreationInput);
  };
  return {
    activateSidebarFilePreview,
    closeSidebarFilePreview,
    deleteSidebarFileEntry,
    openSidebarFilePreview,
    openSidebarFolderGraph,
    openSidebarFolderNative,
    openSidebarFolderTerminal,
    pinSidebarFile,
    pinSidebarFilePath,
    renameSidebarFileEntry,
    retrySidebarFileTree,
  } as const;
}
