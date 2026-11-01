import type {
  ExplorerEntry,
  ExplorerSummary,
  ProjectFolderSetupJobSummary,
  ProjectSummary,
  ProjectReplicaJobSummary,
} from "@cantrip/protocol";

import {
  ProjectSidebarFileTree,
  type ExplorerFileMutationAuthorization,
} from "@/components/sidebar/project-sidebar-file-tree";
import type { SidebarFileImporter } from "./sidebar-file-drop";

export function ProjectChatList({
  filesVisible = true,
  fileExplorer,
  filePreviewPath,
  fileTreeError,
  fileGraphAvailable,
  fileTreeLoading,
  fileTreePinningPath,
  fileTreeWorkerId,
  fileTreeWorkerOnline,
  fileRevealLabel,
  overviewSelected,
  onFilePin,
  onFileCreateFolder,
  onFileCreateFile,
  onFileImport,
  onFileDelete,
  onFileOpenGraph,
  onFileOpenNative,
  onFileOpenNativeRoot,
  onFileOpenTerminal,
  onFilePreview,
  onFileOpenAs,
  onFileRename,
  onFileTreeRetry,
  onOpenProjectSettings,
  onRevealProject,
  onRemoveProject,
  onSelectProject,
  folderSetupJobs,
  projects,
  projectSetupJobs,
  projectRevealLabel,
  selectedProjectId,
}: {
  filesVisible?: boolean;
  onFileImport?: (
    explorer: ExplorerSummary,
    ...args: Parameters<SidebarFileImporter>
  ) => Promise<void>;
  fileExplorer: ExplorerSummary | null;
  filePreviewPath: string | null;
  fileTreeError?: string | null;
  fileGraphAvailable: boolean;
  fileTreeLoading: boolean;
  fileTreePinningPath?: string | null;
  fileTreeWorkerId: string | null;
  fileTreeWorkerOnline: boolean;
  fileRevealLabel?: string;
  overviewSelected: boolean;
  onFilePin(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileCreateFolder(
    explorer: ExplorerSummary,
    parentPath: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
  onFileCreateFile(
    explorer: ExplorerSummary,
    parentPath: string,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<ExplorerEntry>;
  onFileDelete(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onFileOpenGraph(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileOpenNative(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    localFolder: boolean,
  ): void;
  onFileOpenNativeRoot(explorer: ExplorerSummary, localFolder: boolean): void;
  onFileOpenTerminal(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFilePreview(explorer: ExplorerSummary, entry: ExplorerEntry): void;
  onFileOpenAs?(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    viewer: string | null,
  ): void;
  onFileRename(
    explorer: ExplorerSummary,
    entry: ExplorerEntry,
    name: string,
    authorization: ExplorerFileMutationAuthorization,
  ): Promise<void>;
  onFileTreeRetry?(): void;
  onOpenProjectSettings(projectId: string): void;
  onRevealProject?: (
    project: ProjectSummary,
    localFolder: boolean,
  ) => Promise<void>;
  onRemoveProject(projectId: string, deleteLocalFiles: boolean): Promise<void>;
  onSelectProject(projectId: string): void;
  folderSetupJobs: ReadonlyMap<string, ProjectFolderSetupJobSummary>;
  projects: ProjectSummary[];
  projectSetupJobs: ReadonlyMap<string, ProjectReplicaJobSummary>;
  projectRevealLabel?: string;
  selectedProjectId: string | null;
}) {
  return (
    <>
      <div className="contents">
        {projects.map((project) => {
          const active = project.id === selectedProjectId;
          if (!active) return null;
          return (
            <div key={project.id} className="flex min-h-full flex-col">
              {active ? (
                <div className="flex min-h-8 flex-1 flex-col rounded-md transition-colors">
                  <ProjectSidebarFileTree
                    visible={filesVisible}
                    activePath={filePreviewPath}
                    error={fileTreeError}
                    explorer={fileExplorer}
                    loading={fileTreeLoading}
                    onImportFiles={
                      fileExplorer && onFileImport
                        ? (...args) => onFileImport(fileExplorer, ...args)
                        : undefined
                    }
                    onCreateFile={(parentPath, name, authorization) => {
                      if (!fileExplorer)
                        return Promise.reject(
                          new Error(
                            "The project file explorer is unavailable.",
                          ),
                        );
                      return onFileCreateFile(
                        fileExplorer,
                        parentPath,
                        name,
                        authorization,
                      );
                    }}
                    onCreateFolder={(parentPath, authorization) => {
                      if (!fileExplorer) {
                        return Promise.reject(
                          new Error(
                            "The project file explorer is unavailable.",
                          ),
                        );
                      }
                      return onFileCreateFolder(
                        fileExplorer,
                        parentPath,
                        authorization,
                      );
                    }}
                    onDelete={(entry, authorization) => {
                      if (!fileExplorer) {
                        return Promise.reject(
                          new Error(
                            "The project file explorer is unavailable.",
                          ),
                        );
                      }
                      return onFileDelete(fileExplorer, entry, authorization);
                    }}
                    onOpenGraph={
                      fileGraphAvailable && fileExplorer
                        ? (entry) => onFileOpenGraph(fileExplorer, entry)
                        : undefined
                    }
                    onOpenNative={
                      fileRevealLabel && fileExplorer
                        ? (entry, localFolder) =>
                            onFileOpenNative(fileExplorer, entry, localFolder)
                        : undefined
                    }
                    onOpenNativeRoot={
                      fileRevealLabel && fileExplorer
                        ? (localFolder) =>
                            onFileOpenNativeRoot(fileExplorer, localFolder)
                        : undefined
                    }
                    onOpenTerminal={
                      fileExplorer
                        ? (entry) => onFileOpenTerminal(fileExplorer, entry)
                        : undefined
                    }
                    onPin={(entry) => {
                      if (fileExplorer) onFilePin(fileExplorer, entry);
                    }}
                    onOpenAs={
                      onFileOpenAs
                        ? (entry, viewer) => {
                            if (fileExplorer)
                              onFileOpenAs(fileExplorer, entry, viewer);
                          }
                        : undefined
                    }
                    onPreview={(entry) => {
                      if (fileExplorer) onFilePreview(fileExplorer, entry);
                    }}
                    onRename={(entry, name, authorization) => {
                      if (!fileExplorer) {
                        return Promise.reject(
                          new Error(
                            "The project file explorer is unavailable.",
                          ),
                        );
                      }
                      return onFileRename(
                        fileExplorer,
                        entry,
                        name,
                        authorization,
                      );
                    }}
                    onRetry={onFileTreeRetry}
                    pinningPath={fileTreePinningPath}
                    revealLabel={fileRevealLabel}
                    workerId={fileTreeWorkerId}
                    workerOnline={fileTreeWorkerOnline}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
