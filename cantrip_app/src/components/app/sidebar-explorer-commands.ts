import type {
  ExecutionTarget,
  ExplorerEntry,
  ExplorerSummary,
  ProjectSummary,
  ProjectPaneSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type {
  ExplorerLifecycleRefs,
  SidebarExplorerMutations,
  SidebarFileState,
} from "@/components/app/sidebar-explorer-controller";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import { confirmExplorerDiscard } from "@/components/explorer/explorer-lifecycle";
import type { ExplorerFileMutationAuthorization } from "@/components/sidebar/project-sidebar-file-tree";
import {
  createExplorerDirectory,
  createExplorerFile,
  deleteExplorerEntry,
  renameExplorerEntry,
  updateExplorerViewState,
} from "@/lib/api";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { errorMessage as errorText } from "@/lib/error-message";
import { recordExplorerFileIntent } from "@/lib/explorer-lifecycle-trace";
import {
  moveSidebarPath,
  sidebarFileTargetPaneId,
  sidebarPathAtOrBelow,
} from "@/lib/sidebar-file-tabs";
import {
  selectWorkspacePane,
  type WorkspaceSelection,
} from "@/lib/workspace-selection";

interface MutationOperation<Input> {
  isPending?: boolean;
  mutate(input: Input): void;
  reset(): void;
}

export function createSidebarExplorerCommands({
  createSidebarExplorerMutation,
  explorers,
  fileState,
  lifecycle,
  newGraphExplorer,
  newTerminal,
  openOwnedFile,
  projects,
  queryClient,
  revealWorkspace,
  selectedPane,
  setDesktopSidebarDrawerOpen,
  setPopoutError,
  setWorkspaceSelection,
  sidebarExplorerCreationInput,
  sidebarExplorerCreationKey,
  tabLayout,
  worktrees,
}: {
  createSidebarExplorerMutation: SidebarExplorerMutations["createSidebarExplorerMutation"];
  explorers: ExplorerSummary[] | undefined;
  fileState: Pick<
    SidebarFileState,
    "setSidebarFilePreview" | "sidebarFilePreview"
  >;
  lifecycle: ExplorerLifecycleRefs;
  newGraphExplorer: MutationOperation<{
    entry: ExplorerEntry;
    explorer: ExplorerSummary;
    paneId?: string;
  }>;
  newTerminal: MutationOperation<{
    directoryPath?: string;
    projectId: string;
    paneId?: string;
    target?: ExecutionTarget;
    title?: string;
    worktreeId?: string;
  }>;
  openOwnedFile: (
    explorer: ExplorerSummary,
    path: string,
    preview: boolean,
  ) => Promise<void>;
  projects: ProjectSummary[] | undefined;
  queryClient: QueryClient;
  revealWorkspace: () => void;
  selectedPane: ProjectPaneSummary | undefined;
  setDesktopSidebarDrawerOpen: (open: boolean) => void;
  setPopoutError: (error: string | null) => void;
  setWorkspaceSelection: Dispatch<SetStateAction<WorkspaceSelection>>;
  sidebarExplorerCreationInput: {
    projectId: string;
    worktreeId?: string;
  } | null;
  sidebarExplorerCreationKey: string | null;
  tabLayout: ProjectTabLayoutSummary | undefined;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const { setSidebarFilePreview, sidebarFilePreview } = fileState;
  const {
    explorerLifecycleRef,
    sidebarExplorerCreationKeyRef,
    sidebarFilePreviewLifecycleRef,
  } = lifecycle;
  const sidebarFilePaneId = (explorer: ExplorerSummary): string | null => {
    return sidebarFileTargetPaneId({
      activePaneId: selectedPane?.id,
      explorerId: explorer.id,
      panes: tabLayout?.panes ?? [],
      preview: sidebarFilePreview,
    });
  };
  const openSidebarFilePreviewPath = (
    explorer: ExplorerSummary,
    path: string,
  ) => {
    void openOwnedFile(explorer, path, true)
      .then(() => {
        setDesktopSidebarDrawerOpen(false);
        revealWorkspace();
      })
      .catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openSidebarFilePreview = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    if (entry.kind !== "file" || !entry.viewable) return;
    openSidebarFilePreviewPath(explorer, entry.path);
  };
  const pinSidebarFilePath = async (
    explorer: ExplorerSummary,
    path: string,
  ) => {
    try {
      await openOwnedFile(explorer, path, false);
      setDesktopSidebarDrawerOpen(false);
      revealWorkspace();
    } catch (error) {
      setPopoutError(errorText(error));
    }
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
  const createSidebarFile = async (
    explorer: ExplorerSummary,
    parentPath: string,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    if (!authorization.isCurrent())
      throw new Error(
        "Explorer authorization changed. Try creating the file again.",
      );
    const created = await createExplorerFile(
      explorer.id,
      {
        path: parentPath,
        name,
      },
      {
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
        workerId: explorer.activeWorkerId,
      },
    );
    if (authorization.isCurrent())
      await refreshSidebarExplorerEntries(explorer);
    return created;
  };
  const createSidebarFolder = async (
    explorer: ExplorerSummary,
    parentPath: string,
    authorization: ExplorerFileMutationAuthorization,
  ) => {
    if (!authorization.isCurrent()) {
      throw new Error(
        "Explorer authorization changed. Try creating the folder again.",
      );
    }
    const created = await createExplorerDirectory(explorer.id, {
      path: parentPath,
    });
    if (!authorization.isCurrent()) return created;
    await refreshSidebarExplorerEntries(explorer);
    return created;
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
    const worktree = worktrees?.find(
      (candidate) => candidate.id === explorer.worktreeId,
    );
    void revealProjectInNativeFileManager(
      project,
      localFolder,
      entry.path,
      worktree,
    ).catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openSidebarRootNative = (
    explorer: ExplorerSummary,
    localFolder: boolean,
  ) => {
    const project = (projects ?? []).find(
      (candidate) => candidate.id === explorer.projectId,
    );
    if (!project?.source) return;
    const worktree = worktrees?.find(
      (candidate) => candidate.id === explorer.worktreeId,
    );
    void revealProjectInNativeFileManager(
      project,
      localFolder,
      "",
      worktree,
    ).catch((error: unknown) => setPopoutError(errorText(error)));
  };
  const openSidebarFolderTerminal = (
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
  ) => {
    newTerminal.mutate({
      projectId: explorer.projectId,
      directoryPath: entry.path,
      paneId: sidebarFilePaneId(explorer) ?? undefined,
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
      paneId: sidebarFilePaneId(explorer) ?? undefined,
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
    if (
      tabLayout &&
      sidebarFilePreview.paneId &&
      selectedPane?.id !== sidebarFilePreview.paneId
    ) {
      setWorkspaceSelection((current) =>
        selectWorkspacePane(current, tabLayout, sidebarFilePreview.paneId!),
      );
    }
    if (!sidebarFilePreview.active) {
      setSidebarFilePreview((current) =>
        current ? { ...current, active: true } : null,
      );
    }
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
    createSidebarFolder,
    createSidebarFile,
    deleteSidebarFileEntry,
    openSidebarFilePreview,
    openSidebarFilePreviewPath,
    openSidebarFolderGraph,
    openSidebarFolderNative,
    openSidebarRootNative,
    openSidebarFolderTerminal,
    pinSidebarFile,
    pinSidebarFilePath,
    renameSidebarFileEntry,
    retrySidebarFileTree,
  } as const;
}
