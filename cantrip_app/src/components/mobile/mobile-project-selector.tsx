import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  CircleAlert,
  FolderGit2,
  Loader2,
  Plus,
  Search,
  Settings,
  WandSparkles,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";

import { ServerSwitcher } from "@/components/servers/server-switcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { searchProjects } from "@/lib/project-workspaces";

function projectStatus(
  project: ProjectSummary,
  workers: readonly WorkerSummary[],
): { icon?: "error" | "loading" | "offline"; label: string } {
  if (project.setupStatus === "cloning") {
    return { icon: "loading", label: "Cloning" };
  }
  if (project.setupStatus === "failed") {
    return { icon: "error", label: "Setup failed" };
  }
  if (
    project.source &&
    !workers.some(
      ({ online, workerId }) => online && workerId === project.source?.workerId,
    )
  ) {
    return { icon: "offline", label: "Worker offline" };
  }
  return { label: "Ready" };
}

export function MobileProjectSelector({
  activeWorkspace,
  currentUserName,
  error,
  loading,
  onCreateWorkspace,
  onManageWorkspaces,
  onNewProject,
  onOpenSettings,
  onSelectProject,
  onSelectWorkspace,
  projects,
  workers,
  workspaces,
}: {
  activeWorkspace: ProjectWorkspaceSummary | null;
  currentUserName: string;
  error?: string | null;
  loading: boolean;
  onCreateWorkspace(name: string): Promise<void>;
  onManageWorkspaces(): void;
  onNewProject(): void;
  onOpenSettings(): void;
  onSelectProject(projectId: string): void;
  onSelectWorkspace(workspaceId: string): void;
  projects: ProjectSummary[];
  workers: WorkerSummary[];
  workspaces: ProjectWorkspaceSummary[];
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => searchProjects(projects, workspaces, activeWorkspace, query),
    [activeWorkspace, projects, query, workspaces],
  );
  const searchingEverywhere = Boolean(query.trim());
  const onlineWorker = workers.find(({ online }) => online) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="mobile-safe-top flex shrink-0 items-center gap-3 px-4 py-4">
        <div className="grid size-9 place-items-center rounded-full border">
          <WandSparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-semibold tracking-tight">Cantrip</h1>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${onlineWorker ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
            />
            {onlineWorker ? `${onlineWorker.name} online` : "Worker offline"}
          </p>
        </div>
      </header>

      <div className="shrink-0 space-y-3 border-y px-4 py-3">
        <WorkspaceSwitcher
          activeWorkspaceId={activeWorkspace?.id ?? null}
          workspaces={workspaces}
          onSelect={onSelectWorkspace}
          onCreate={onCreateWorkspace}
          onAddProject={onNewProject}
          onManage={onManageWorkspaces}
        />
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search projects"
            autoFocus
            className="h-11 pl-9"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {searchingEverywhere
            ? "Searching across every workspace"
            : `Showing ${activeWorkspace?.name ?? "all projects"}`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="grid min-h-40 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="grid min-h-40 place-items-center px-6 text-center">
            <div>
              <CircleAlert className="mx-auto size-5 text-destructive" />
              <p className="mt-3 text-sm font-medium">
                Could not load projects
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {error}
              </p>
            </div>
          </div>
        ) : results.length > 0 ? (
          <nav aria-label="Projects" className="space-y-1">
            {results.map(({ memberships, project }) => {
              const status = projectStatus(project, workers);
              return (
                <button
                  key={project.id}
                  className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelectProject(project.id)}
                  type="button"
                >
                  <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-card">
                    <FolderGit2 className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {project.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                        {status.icon === "loading" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : status.icon === "error" ? (
                          <CircleAlert className="size-3 text-destructive" />
                        ) : status.icon === "offline" ? (
                          <WifiOff className="size-3" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-emerald-500" />
                        )}
                        {status.label}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {project.github?.nameWithOwner ??
                        project.source?.displayPath ??
                        "Source unavailable"}
                    </p>
                    {project.github && project.source ? (
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
                        {project.source.displayPath}
                      </p>
                    ) : null}
                    {searchingEverywhere && memberships.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {memberships.map((workspace) => (
                          <Badge
                            key={workspace.id}
                            className="h-5 px-1.5 text-[9px] font-normal"
                            variant={
                              workspace.id === activeWorkspace?.id
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {workspace.name}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="grid min-h-40 place-items-center px-6 text-center">
            <div>
              <FolderGit2 className="mx-auto size-5 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">
                {searchingEverywhere
                  ? "No matching projects"
                  : "No projects here"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {searchingEverywhere
                  ? "Try another project, repository, path, or workspace name."
                  : "Add a project or choose another workspace."}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-3 pt-2">
        <Button className="h-11 w-full" onClick={onNewProject}>
          <Plus className="size-4" />
          New Project
        </Button>
      </div>
      <footer className="mobile-safe-bottom flex shrink-0 items-center gap-1 border-t px-3 py-2">
        <ServerSwitcher
          currentUserName={currentUserName}
          workerName={onlineWorker?.name ?? "Worker offline"}
        />
        <Button
          aria-label="Open settings"
          className="size-9"
          onClick={onOpenSettings}
          size="icon"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>
      </footer>
    </div>
  );
}
