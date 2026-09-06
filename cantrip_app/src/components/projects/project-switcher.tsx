import type {
  ExecutionTarget,
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { Check, ChevronDown, FolderGit2, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";

import {
  ProjectContextMenu,
  type ProjectMenuActions,
} from "@/components/projects/project-actions-menu";
import {
  ProjectCreateMenu,
  type ProjectCreateSource,
} from "@/components/projects/project-create-menu";
import { ProjectRemovalDialog } from "@/components/projects/project-removal-dialog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ProjectSurfaceCreateMenu,
  type ProjectSurfaceCreateKind,
  type ProjectSurfacePlacementContext,
} from "@/components/workspace/project-surface-create-menu";
import { searchProjects } from "@/lib/project-workspaces";
import { cn } from "@/lib/utils";

function projectContext(
  project: ProjectSummary,
  workspace: ProjectWorkspaceSummary | null,
  showWorkspace: boolean,
): string {
  if (showWorkspace && workspace) {
    return workspace.name;
  }
  return (
    project.github?.nameWithOwner ||
    project.source?.displayPath ||
    workspace?.name ||
    "Project"
  );
}

export function ProjectSwitcher({
  activeWorkspaceId,
  creatingTabKinds,
  onAddProject,
  onCreateTab,
  onManageWorkspaces,
  onOpenProjectSettings,
  onOpenTabPicker,
  onRemoveProject,
  onRevealProject,
  onSelectProject,
  onSelectWorkspace,
  projectRevealLabel,
  projects,
  selectedProjectId,
  tabPlacement,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  creatingTabKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onAddProject(source: ProjectCreateSource): void;
  onCreateTab(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  onManageWorkspaces(): void;
  onOpenProjectSettings(projectId: string): void;
  onOpenTabPicker?(): void;
  onRemoveProject(projectId: string, deleteLocalFiles: boolean): Promise<void>;
  onRevealProject?: (
    project: ProjectSummary,
    localFolder: boolean,
  ) => Promise<void>;
  onSelectProject(projectId: string): void;
  onSelectWorkspace(workspaceId: string): void;
  projectRevealLabel?: string;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  tabPlacement?: ProjectSurfacePlacementContext;
  workspaces: ProjectWorkspaceSummary[];
}) {
  const activeWorkspace =
    workspaces.find(({ id }) => id === activeWorkspaceId) ??
    workspaces.find(({ isDefault }) => isDefault) ??
    workspaces[0] ??
    null;
  const selectedProject =
    projects.find(({ id }) => id === selectedProjectId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<ProjectSummary | null>(null);
  const [revealingProjectId, setRevealingProjectId] = useState<string | null>(
    null,
  );
  const [revealError, setRevealError] = useState<string | null>(null);
  const results = useMemo(
    () => searchProjects(projects, workspaces, activeWorkspace, query),
    [activeWorkspace, projects, query, workspaces],
  );
  const searchingEverywhere = Boolean(query.trim());

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
  };
  const revealProject = (project: ProjectSummary, localFolder: boolean) => {
    if (!onRevealProject || revealingProjectId) return;
    setOpen(false);
    setRevealError(null);
    setRevealingProjectId(project.id);
    void onRevealProject(project, localFolder)
      .catch((error: unknown) => {
        setRevealError(
          error instanceof Error
            ? error.message
            : "Could not reveal this project.",
        );
      })
      .finally(() => setRevealingProjectId(null));
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <Popover open={open} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Switch project"
            >
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[9px] font-medium uppercase leading-3 tracking-wider text-muted-foreground">
                  {activeWorkspace?.name ?? "Projects"}
                </span>
                <span className="block truncate text-xs font-semibold leading-4 text-foreground">
                  {selectedProject?.name ?? "Select project"}
                </span>
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="z-[80] w-[min(22rem,calc(100vw-2rem))] overflow-hidden p-0"
          >
            <Command shouldFilter={false}>
              <CommandInput
                aria-label="Search all projects"
                autoFocus
                placeholder="Search all projects…"
                value={query}
                onValueChange={setQuery}
              />
              <div
                aria-label="Filter projects by workspace"
                className="flex gap-1 overflow-x-auto border-b px-2 py-2"
                role="tablist"
              >
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    aria-selected={workspace.id === activeWorkspace?.id}
                    className={cn(
                      "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      workspace.id === activeWorkspace?.id
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() => onSelectWorkspace(workspace.id)}
                    role="tab"
                    type="button"
                  >
                    {workspace.name}
                  </button>
                ))}
              </div>
              <div className="border-b px-3 py-1.5 text-[10px] text-muted-foreground">
                {searchingEverywhere
                  ? "Searching across every workspace"
                  : `${results.length} project${results.length === 1 ? "" : "s"} in ${activeWorkspace?.name ?? "all projects"}`}
              </div>
              <CommandList className="max-h-72">
                {results.length > 0 ? (
                  <CommandGroup
                    heading={searchingEverywhere ? "All projects" : undefined}
                  >
                    {results.map(({ project, workspace }) => {
                      const actions: ProjectMenuActions = {
                        onOpenSettings: () => {
                          setOpen(false);
                          onOpenProjectSettings(project.id);
                        },
                        onRemove: () => {
                          setOpen(false);
                          setRemoveProjectTarget(project);
                        },
                        onReveal:
                          project.source &&
                          projectRevealLabel &&
                          onRevealProject
                            ? (localFolder) =>
                                revealProject(project, localFolder)
                            : undefined,
                        revealDisabled: revealingProjectId !== null,
                        revealLabel: projectRevealLabel,
                      };
                      return (
                        <ProjectContextMenu actions={actions} key={project.id}>
                          <CommandItem
                            className="py-2"
                            data-slot="project-switcher-project"
                            onSelect={() => {
                              onSelectProject(project.id);
                              setOpen(false);
                            }}
                            value={project.id}
                          >
                            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {project.name}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {projectContext(
                                  project,
                                  workspace,
                                  searchingEverywhere,
                                )}
                              </span>
                            </span>
                            {project.id === selectedProject?.id ? (
                              <Check className="size-4 shrink-0" />
                            ) : null}
                          </CommandItem>
                        </ProjectContextMenu>
                      );
                    })}
                  </CommandGroup>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {searchingEverywhere
                      ? "No projects match this search."
                      : `No projects in ${activeWorkspace?.name ?? "this workspace"}.`}
                  </div>
                )}
              </CommandList>
              <div
                className="flex items-center justify-between gap-1 border-t p-1"
                data-slot="project-switcher-footer"
              >
                <Button
                  aria-label="Manage workspaces"
                  className="size-8 shrink-0"
                  onClick={() => {
                    setOpen(false);
                    onManageWorkspaces();
                  }}
                  title="Manage workspaces"
                  type="button"
                  size="icon"
                  variant="ghost"
                >
                  <Settings className="size-3.5" />
                </Button>
                <ProjectCreateMenu
                  contentClassName="z-[90]"
                  onSelect={(source) => {
                    setOpen(false);
                    onAddProject(source);
                  }}
                >
                  <Button
                    className="h-8 px-2 text-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Plus className="size-3.5" />
                    New project
                  </Button>
                </ProjectCreateMenu>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
        {selectedProject && onOpenTabPicker ? (
          <Button
            aria-label={`Choose tab for ${selectedProject.name}`}
            className="size-7 shrink-0"
            onClick={onOpenTabPicker}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Plus className="size-4" />
          </Button>
        ) : selectedProject ? (
          <ProjectSurfaceCreateMenu
            align="end"
            creatingKinds={creatingTabKinds}
            onCreate={onCreateTab}
            placement={tabPlacement}
            trigger={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label={`Add tab to ${selectedProject.name}`}
              >
                <Plus className="size-4" />
              </Button>
            }
          />
        ) : null}
      </div>
      <ProjectRemovalDialog
        onOpenChange={(nextOpen) => !nextOpen && setRemoveProjectTarget(null)}
        onRemove={onRemoveProject}
        project={removeProjectTarget}
      />
      {revealError ? (
        <InlineAlert
          className="fixed bottom-5 right-5 z-[110] max-w-md border-destructive bg-destructive px-4 py-3 text-destructive-foreground shadow-xl"
          dismissLabel="Dismiss project reveal error"
          icon={false}
          onDismiss={() => setRevealError(null)}
          tone="error"
        >
          Could not reveal project: {revealError}
        </InlineAlert>
      ) : null}
    </>
  );
}
