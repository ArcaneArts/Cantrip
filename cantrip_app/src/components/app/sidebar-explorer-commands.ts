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

import type {
  ExplorerLifecycleRefs,
  SidebarExplorerMutations,
} from "@/components/app/sidebar-explorer-controller";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import type { ExplorerFileMutationAuthorization } from "@/components/sidebar/project-sidebar-file-tree";
import {
  createExplorerDirectory,
  createExplorerFile,
  importExplorerFile,
  deleteExplorerEntry,
  renameExplorerEntry,
  updateExplorerViewState,
} from "@/lib/api";
import { revealProjectInNativeFileManager } from "@/lib/desktop-project-share";
import { errorMessage as errorText } from "@/lib/error-message";
import {
  moveSidebarPath,
  sidebarFileTargetPaneId,
  sidebarPathAtOrBelow,
} from "@/lib/sidebar-file-tabs";
import type { SidebarFileImportProgress } from "@/components/sidebar/sidebar-file-drop";

interface MutationOperation<Input> {
  isPending?: boolean;
  mutate(input: Input): void;
  reset(): void;
}

export function createSidebarExplorerCommands({
  createSidebarExplorerMutation,
  explorers,
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
  sidebarExplorerCreationInput,
  sidebarExplorerCreationKey,
  tabLayout,
  worktrees,
}: {
  createSidebarExplorerMutation: SidebarExplorerMutations["createSidebarExplorerMutation"];
  explorers: ExplorerSummary[] | undefined;
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
  sidebarExplorerCreationInput: {
    projectId: string;
    worktreeId?: string;
  } | null;
  sidebarExplorerCreationKey: string | null;
  tabLayout: ProjectTabLayoutSummary | undefined;
  worktrees: ProjectWorktreeSummary[] | undefined;
}) {
  const { explorerLifecycleRef, sidebarExplorerCreationKeyRef } = lifecycle;
  const sidebarFilePaneId = (): string | null => {
    return sidebarFileTargetPaneId({
      activePaneId: selectedPane?.id,
      panes: tabLayout?.panes ?? [],
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
  const importSidebarFiles = async (
    explorer: ExplorerSummary,
    parentPath: string,
    files: File[],
    authorization: ExplorerFileMutationAuthorization,
    onProgress: (progress: SidebarFileImportProgress) => void,
  ) => {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    try {
      for (const [index, file] of files.entries()) {
        try {
          await importExplorerFile(
            explorer.id,
            parentPath,
            file,
            {
              projectId: explorer.projectId,
              worktreeId: explorer.worktreeId,
              workerId: explorer.activeWorkerId,
            },
            {
              isCurrent: authorization.isCurrent,
              onProgress: (bytes) =>
                onProgress({
                  name: file.name,
                  index,
                  count: files.length,
                  total,
                  completed: completed + bytes,
                }),
            },
          );
          completed += file.size;
        } catch (error) {
          throw new Error(
            `Could not add ${file.name}: ${errorText(error)}${index ? ` ${index} file${index === 1 ? " was" : "s were"} already added.` : ""}`,
          );
        }
      }
    } finally {
      if (authorization.isCurrent())
        await refreshSidebarExplorerEntries(explorer);
    }
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
      paneId: sidebarFilePaneId() ?? undefined,
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
      paneId: sidebarFilePaneId() ?? undefined,
    });
  };
  const retrySidebarFileTree = () => {
    createSidebarExplorerMutation.reset();
    sidebarExplorerCreationKeyRef.current = null;
    if (!sidebarExplorerCreationInput || !sidebarExplorerCreationKey) return;
    sidebarExplorerCreationKeyRef.current = sidebarExplorerCreationKey;
    createSidebarExplorerMutation.mutate(sidebarExplorerCreationInput);
  };
  return {
    createSidebarFolder,
    createSidebarFile,
    importSidebarFiles,
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
