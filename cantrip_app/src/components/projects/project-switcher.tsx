import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import {
  Check,
  ChevronDown,
  FolderGit2,
  Layers3,
  Plus,
  Settings,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  ProjectCreateMenu,
  type ProjectCreateSource,
} from "@/components/projects/project-create-menu";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorkspaceCreateDialog } from "@/components/workspaces/workspace-create-dialog";
import { searchProjects } from "@/lib/project-workspaces";
import { cn } from "@/lib/utils";

function projectContext(
  project: ProjectSummary,
  memberships: readonly ProjectWorkspaceSummary[],
  showMemberships: boolean,
): string {
  if (showMemberships && memberships.length > 0) {
    return memberships.map(({ name }) => name).join(" · ");
  }
  return (
    project.github?.nameWithOwner ||
    project.source?.displayPath ||
    memberships.map(({ name }) => name).join(" · ") ||
    "Project"
  );
}

export function ProjectSwitcher({
  activeWorkspaceId,
  onAddProject,
  onCreateWorkspace,
  onManageWorkspaces,
  onSelectProject,
  onSelectWorkspace,
  projects,
  selectedProjectId,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  onAddProject(source: ProjectCreateSource): void;
  onCreateWorkspace(name: string): Promise<void>;
  onManageWorkspaces(): void;
  onSelectProject(projectId: string): void;
  onSelectWorkspace(workspaceId: string): void;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
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
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const results = useMemo(
    () => searchProjects(projects, workspaces, activeWorkspace, query),
    [activeWorkspace, projects, query, workspaces],
  );
  const searchingEverywhere = Boolean(query.trim());

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
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
                    {results.map(({ memberships, project }) => (
                      <CommandItem
                        key={project.id}
                        className="py-2"
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
                              memberships,
                              searchingEverywhere,
                            )}
                          </span>
                        </span>
                        {project.id === selectedProject?.id ? (
                          <Check className="size-4 shrink-0" />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {searchingEverywhere
                      ? "No projects match this search."
                      : `No projects in ${activeWorkspace?.name ?? "this workspace"}.`}
                  </div>
                )}
              </CommandList>
              <div className="flex items-center gap-1 border-t p-1">
                <Button
                  className="h-8 flex-1 justify-start px-2 text-xs"
                  onClick={() => {
                    setOpen(false);
                    setWorkspaceDialogOpen(true);
                  }}
                  type="button"
                  variant="ghost"
                >
                  <Layers3 className="size-3.5" />
                  New workspace
                </Button>
                <Button
                  className="h-8 flex-1 justify-start px-2 text-xs"
                  onClick={() => {
                    setOpen(false);
                    onManageWorkspaces();
                  }}
                  type="button"
                  variant="ghost"
                >
                  <Settings className="size-3.5" />
                  Manage
                </Button>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
        <ProjectCreateMenu onSelect={onAddProject}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            title={`Add project to ${activeWorkspace?.name ?? "current workspace"}`}
          >
            <Plus className="size-4" />
            <span className="sr-only">
              Add project to {activeWorkspace?.name ?? "current workspace"}
            </span>
          </Button>
        </ProjectCreateMenu>
      </div>

      <WorkspaceCreateDialog
        onCreate={onCreateWorkspace}
        onOpenChange={setWorkspaceDialogOpen}
        open={workspaceDialogOpen}
      />
    </>
  );
}
