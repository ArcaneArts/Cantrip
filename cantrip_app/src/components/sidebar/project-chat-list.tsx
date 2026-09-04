import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  ExplorerEntry,
  ExplorerSummary,
  ProjectFolderSetupJobSummary,
  ProjectSummary,
  ProjectReplicaJobSummary,
} from "@cantrip/protocol";
import {
  CircleAlert,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  WifiOff,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  projectFolderSetupErrorMessage,
  projectReplicaJobMessage,
  projectSetupErrorMessage,
} from "@/lib/job-status-message";

import { InlineAlert } from "@/components/ui/inline-alert";
import {
  ProjectSidebarFileTree,
  type ExplorerFileMutationAuthorization,
} from "@/components/sidebar/project-sidebar-file-tree";
import {
  ProjectContextMenu,
  ProjectDropdownMenu,
  type ProjectMenuActions,
} from "@/components/projects/project-actions-menu";
import { ProjectRemovalDialog } from "@/components/projects/project-removal-dialog";
import { cn } from "@/lib/utils";

const projectId = (id: string) => `project:${id}`;

export function ProjectOverviewTab({
  active,
  children,
  onOpenSettings,
  onReveal,
  onRemove,
  onSelect,
  project,
  folderSetupJob,
  setupJob,
  projectRevealLabel,
  revealDisabled,
}: {
  active: boolean;
  children?: ReactNode;
  onOpenSettings(): void;
  onReveal?: (localFolder: boolean) => void;
  onRemove(): void;
  onSelect(): void;
  project: ProjectSummary;
  folderSetupJob?: ProjectFolderSetupJobSummary;
  setupJob?: ProjectReplicaJobSummary;
  projectRevealLabel?: string;
  revealDisabled: boolean;
}) {
  const cloning = project.setupStatus === "cloning";
  const preparing = project.setupStatus === "preparing";
  const settingUp = cloning || preparing;
  const failed = project.setupStatus === "failed";
  const folderBlocked = preparing && folderSetupJob?.state === "blocked";
  const actions: ProjectMenuActions = {
    onOpenSettings,
    onRemove,
    onReveal,
    revealDisabled,
    revealLabel: projectRevealLabel,
  };
  return (
    <div className="group mb-1 flex min-h-full flex-col">
      <ProjectContextMenu actions={actions}>
        <div
          title={
            failed
              ? (projectSetupErrorMessage(project.setupError) ?? undefined)
              : folderSetupJob?.error
                ? projectFolderSetupErrorMessage(folderSetupJob.error.code)
                : setupJob
                  ? projectReplicaJobMessage(setupJob)
                  : undefined
          }
          className={cn(
            "flex h-8 items-center rounded-md hover:bg-muted",
            active && "bg-muted font-medium",
          )}
        >
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              settingUp && "cursor-default",
            )}
            onClick={onSelect}
          >
            {folderBlocked ? (
              <WifiOff className="size-3.5 shrink-0 text-amber-500" />
            ) : settingUp ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : failed ? (
              <CircleAlert className="size-3.5 shrink-0 text-destructive" />
            ) : (
              <LayoutDashboard className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{project.name}</span>
            {settingUp || failed ? (
              <span
                className={cn(
                  "ml-auto shrink-0 text-[10px] font-normal text-muted-foreground",
                  failed && "text-destructive",
                )}
              >
                {folderBlocked
                  ? "Worker offline"
                  : cloning
                    ? setupJob
                      ? `${setupJob.progress.percent}%`
                      : "Starting"
                    : preparing
                      ? "Preparing"
                      : "Failed"}
              </span>
            ) : null}
          </button>
          {settingUp && !folderBlocked ? null : (
            <ProjectDropdownMenu actions={actions}>
              <button
                type="button"
                aria-label={`Project actions for ${project.name}`}
                onClick={(event) => event.stopPropagation()}
                className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
                <span className="sr-only">
                  Project actions for {project.name}
                </span>
              </button>
            </ProjectDropdownMenu>
          )}
        </div>
      </ProjectContextMenu>
      {children}
    </div>
  );
}

export function ProjectChatList({
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
  onFileDelete,
  onFileOpenGraph,
  onFileOpenNative,
  onFileOpenNativeRoot,
  onFileOpenTerminal,
  onFilePreview,
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
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<ProjectSummary | null>(null);
  const [revealingProjectId, setRevealingProjectId] = useState<string | null>(
    null,
  );
  const [projectRevealError, setProjectRevealError] = useState<string | null>(
    null,
  );
  return (
    <>
      <div className="contents">
        <SortableContext
          items={projects.map((project) => projectId(project.id))}
          strategy={verticalListSortingStrategy}
        >
          {projects.map((project) => {
            const active = project.id === selectedProjectId;
            if (!active) return null;
            return (
              <ProjectOverviewTab
                key={project.id}
                project={project}
                folderSetupJob={folderSetupJobs.get(project.id)}
                setupJob={projectSetupJobs.get(project.id)}
                active={overviewSelected}
                onOpenSettings={() => onOpenProjectSettings(project.id)}
                onReveal={
                  project.source && projectRevealLabel && onRevealProject
                    ? (localFolder) => {
                        if (revealingProjectId) return;
                        setProjectRevealError(null);
                        setRevealingProjectId(project.id);
                        void onRevealProject(project, localFolder)
                          .catch((error: unknown) => {
                            setProjectRevealError(
                              error instanceof Error
                                ? error.message
                                : "Could not reveal this project.",
                            );
                          })
                          .finally(() => setRevealingProjectId(null));
                      }
                    : undefined
                }
                projectRevealLabel={projectRevealLabel}
                revealDisabled={revealingProjectId !== null}
                onSelect={() => onSelectProject(project.id)}
                onRemove={() => {
                  setRemoveProjectTarget(project);
                }}
              >
                {active ? (
                  <div className="flex min-h-8 flex-1 flex-col rounded-md transition-colors">
                    <ProjectSidebarFileTree
                      activePath={filePreviewPath}
                      error={fileTreeError}
                      explorer={fileExplorer}
                      loading={fileTreeLoading}
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
              </ProjectOverviewTab>
            );
          })}
        </SortableContext>
      </div>

      {projectRevealError ? (
        <InlineAlert
          tone="error"
          className="fixed bottom-5 right-5 z-50 max-w-md border-destructive bg-destructive px-4 py-3 text-destructive-foreground shadow-xl"
          dismissLabel="Dismiss project reveal error"
          icon={false}
          onDismiss={() => setProjectRevealError(null)}
        >
          Could not reveal project: {projectRevealError}
        </InlineAlert>
      ) : null}

      <ProjectRemovalDialog
        onOpenChange={(open) => !open && setRemoveProjectTarget(null)}
        onRemove={onRemoveProject}
        project={removeProjectTarget}
      />
    </>
  );
}
