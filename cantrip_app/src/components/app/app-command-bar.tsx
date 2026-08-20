import type {
  GithubRepository,
  ProjectSummary,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command as CommandPrimitive } from "cmdk";
import {
  Bot,
  Check,
  CornerDownLeft,
  Folder,
  FolderGit2,
  FolderOpen,
  GitFork,
  Loader2,
  Lock,
  Plus,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  APP_ACTION_IDS,
  availableAppActions,
  type AppActionContext,
  type AppActionId,
} from "@/lib/app-actions";
import {
  getCachedGithubRepositories,
  getGithubRepositories,
  getGithubStatus,
} from "@/lib/api";
import {
  advanceDoubleShiftGesture,
  commandBarScopesAfterBackspace,
  type CommandBarScope,
} from "@/lib/command-bar";
import { errorMessage } from "@/lib/error-message";
import {
  createGithubProject,
  createManagedFolderProject,
} from "@/lib/project-encryption";

const scopeLabels: Record<CommandBarScope, string> = {
  folder: "Folder",
  github: "GitHub",
  "new-project": "New Project",
};

function projectMemberships(
  projectId: string,
  workspaces: readonly ProjectWorkspaceSummary[],
): ProjectWorkspaceSummary[] {
  return workspaces.filter(({ projectIds }) => projectIds.includes(projectId));
}

function projectDetail(
  project: ProjectSummary,
  memberships: readonly ProjectWorkspaceSummary[],
): string {
  const source =
    project.source?.displayPath ??
    project.github?.nameWithOwner ??
    (project.originKind === "managed-folder"
      ? "Worker-bound folder"
      : "GitHub repository");
  const workspaceNames = memberships.map(({ name }) => name).join(", ");
  return workspaceNames ? `${source} · ${workspaceNames}` : source;
}

function AppActionIcon({ actionId }: { actionId: AppActionId }) {
  if (actionId === APP_ACTION_IDS.newProject) {
    return <FolderOpen className="size-4" />;
  }
  return actionId === APP_ACTION_IDS.newAgentChat ? (
    <Bot className="size-4" />
  ) : (
    <SquareTerminal className="size-4" />
  );
}

function RepositoryIcon({ repository }: { repository: GithubRepository }) {
  return repository.isPrivate ? (
    <Lock className="size-4" />
  ) : repository.isFork ? (
    <GitFork className="size-4" />
  ) : (
    <FolderGit2 className="size-4" />
  );
}

export function AppCommandBar({
  activeWorkspaceId,
  context,
  currentProjectId,
  defaultWorkerId,
  onAction,
  onCreatedProject,
  onOpenChange,
  onOpenFolder,
  onSelectProject,
  open,
  projects,
  workers,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  context: AppActionContext;
  currentProjectId: string | null;
  defaultWorkerId: string | null;
  onAction(actionId: AppActionId): void;
  onCreatedProject(project: ProjectSummary): void;
  onOpenChange(open: boolean): void;
  onOpenFolder(): void;
  onSelectProject(projectId: string): void;
  open: boolean;
  projects: readonly ProjectSummary[];
  workers: readonly WorkerSummary[];
  workspaces: readonly ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<CommandBarScope[]>([]);
  const [folderSubmitting, setFolderSubmitting] = useState(false);
  const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(
    null,
  );
  const [operationError, setOperationError] = useState<string | null>(null);
  const lastShiftAtRef = useRef<number | null>(null);
  const actions = useMemo(() => availableAppActions(context), [context]);
  const activeScope = scopes.at(-1) ?? null;
  const githubWorkerId =
    workers.find(
      ({ online, workerId }) => online && workerId === defaultWorkerId,
    )?.workerId ??
    workers.find(({ online }) => online)?.workerId ??
    null;
  const folderWorker =
    workers.find(
      ({ managedFolders, online, workerId }) =>
        online && managedFolders.create && workerId === defaultWorkerId,
    ) ??
    workers.find(({ managedFolders, online }) =>
      Boolean(online && managedFolders.create),
    ) ??
    null;
  const github = useQuery({
    enabled: open && activeScope === "github" && Boolean(githubWorkerId),
    queryFn: () => getGithubStatus(githubWorkerId!),
    queryKey: ["github-status", githubWorkerId],
  });
  const repositories = useQuery({
    enabled: Boolean(
      open &&
      activeScope === "github" &&
      githubWorkerId &&
      github.data?.authenticated,
    ),
    queryFn: () => getGithubRepositories(githubWorkerId!),
    queryKey: ["github-repositories", githubWorkerId],
  });
  const cachedRepositories = useQuery({
    enabled: Boolean(
      open &&
      activeScope === "github" &&
      githubWorkerId &&
      github.data?.authenticated &&
      github.data.login,
    ),
    queryFn: () =>
      getCachedGithubRepositories(githubWorkerId!, github.data!.login!),
    queryKey: ["github-repositories-cache", githubWorkerId, github.data?.login],
    staleTime: 30_000,
  });
  const githubRepositories = repositories.data ?? cachedRepositories.data ?? [];
  const hasGithubRepositoryData = Boolean(
    repositories.data || cachedRepositories.data?.length,
  );
  const githubLoading = Boolean(
    activeScope === "github" &&
    (github.isLoading ||
      (github.data?.authenticated &&
        !hasGithubRepositoryData &&
        (repositories.isLoading || cachedRepositories.isLoading))),
  );

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        lastShiftAtRef.current = null;
        return;
      }
      const result = advanceDoubleShiftGesture(
        lastShiftAtRef.current,
        event,
        performance.now(),
      );
      lastShiftAtRef.current = result.lastShiftAt;
      if (!result.triggered) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScopes([]);
    setOperationError(null);
  }, [open]);

  const rememberProject = (project: ProjectSummary, workspaceId: string) => {
    queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
      [...current.filter((item) => item.id !== project.id), project].sort(
        (left, right) => left.position - right.position,
      ),
    );
    queryClient.setQueryData<ProjectWorkspaceSummary[]>(
      ["project-workspaces"],
      (current) =>
        current?.map((workspace) =>
          workspace.id === workspaceId &&
          !workspace.projectIds.includes(project.id)
            ? {
                ...workspace,
                projectIds: [...workspace.projectIds, project.id],
              }
            : workspace,
        ),
    );
    void queryClient.invalidateQueries({ queryKey: ["project-workspaces"] });
  };

  const armScope = (scope: CommandBarScope) => {
    setScopes((current) =>
      scope === "new-project" ? [scope] : [...current, scope],
    );
    setQuery("");
    setOperationError(null);
  };
  const runAction = (actionId: AppActionId) => {
    if (actionId === APP_ACTION_IDS.newProject) {
      armScope("new-project");
      return;
    }
    onOpenChange(false);
    onAction(actionId);
  };
  const selectProject = (projectId: string) => {
    onOpenChange(false);
    onSelectProject(projectId);
  };
  const createFolder = async () => {
    const name = query.trim();
    if (!name || !folderWorker || !activeWorkspaceId || folderSubmitting) {
      return;
    }
    setFolderSubmitting(true);
    setOperationError(null);
    try {
      const project = await createManagedFolderProject({
        name,
        workerId: folderWorker.workerId,
        workspaceIds: [activeWorkspaceId],
      });
      rememberProject(project, activeWorkspaceId);
      onOpenChange(false);
      onCreatedProject(project);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setFolderSubmitting(false);
    }
  };
  const importRepository = async (repository: GithubRepository) => {
    if (
      !githubWorkerId ||
      !activeWorkspaceId ||
      pendingRepositoryId ||
      repository.imported ||
      projects.some((project) => project.github?.repositoryId === repository.id)
    ) {
      return;
    }
    setPendingRepositoryId(repository.id);
    setOperationError(null);
    try {
      const project = await createGithubProject({
        workerId: githubWorkerId,
        repositoryId: repository.id,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
        workspaceIds: [activeWorkspaceId],
      });
      rememberProject(project, activeWorkspaceId);
      const markImported = (queryKey: readonly unknown[]) =>
        queryClient.setQueryData<GithubRepository[]>(queryKey, (current) =>
          current?.map((item) =>
            item.id === repository.id ? { ...item, imported: true } : item,
          ),
        );
      markImported(["github-repositories", githubWorkerId]);
      if (github.data?.login) {
        markImported([
          "github-repositories-cache",
          githubWorkerId,
          github.data.login,
        ]);
      }
      onOpenChange(false);
      onCreatedProject(project);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setPendingRepositoryId(null);
    }
  };

  const placeholder =
    activeScope === "folder"
      ? "Type a project name or open a folder…"
      : activeScope === "github"
        ? "Search GitHub repositories…"
        : activeScope === "new-project"
          ? "Choose a source or existing project…"
          : "Search actions…";
  const emptyMessage =
    activeScope === "github"
      ? "No GitHub repositories match your search."
      : activeScope === "new-project"
        ? "No projects match your search."
        : "No matching actions.";
  const showEmpty = !(
    activeScope === "github" &&
    (githubLoading ||
      !githubWorkerId ||
      github.isError ||
      (github.data && !github.data.authenticated) ||
      (repositories.isError && !hasGithubRepositoryData))
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[15vh] flex max-h-[70vh] max-w-2xl -translate-y-0 flex-col gap-0 overflow-hidden p-0"
        showClose={false}
      >
        <DialogTitle className="sr-only">Cantrip command bar</DialogTitle>
        <DialogDescription className="sr-only">
          Search available actions, create a project, or switch projects.
        </DialogDescription>
        <Command loop>
          <div className="flex min-h-16 shrink-0 items-center gap-2 border-b px-5 py-2">
            <Search className="size-5 shrink-0 text-muted-foreground" />
            {scopes.map((scope, index) => (
              <button
                key={`${scope}:${index}`}
                type="button"
                className="flex shrink-0 items-center gap-1 rounded-md border bg-muted/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
                onClick={() => {
                  setScopes((current) => current.slice(0, index));
                  setQuery("");
                  setOperationError(null);
                }}
              >
                {scopeLabels[scope]}
                {scope === "github" && githubLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <X className="size-3 text-muted-foreground" />
                )}
              </button>
            ))}
            <CommandPrimitive.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              onKeyDown={(event) => {
                if (event.key !== "Backspace") return;
                const next = commandBarScopesAfterBackspace(scopes, query);
                if (next === scopes) return;
                event.preventDefault();
                setScopes([...next]);
                setOperationError(null);
              }}
              className="min-w-24 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
              placeholder={placeholder}
              aria-label={placeholder}
            />
            {scopes.length === 0 ? (
              <kbd className="hidden shrink-0 rounded-md border bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground sm:inline-flex">
                shift shift
              </kbd>
            ) : null}
          </div>
          <CommandList className="min-h-32 flex-1 overscroll-contain overflow-y-auto p-2">
            {showEmpty ? <CommandEmpty>{emptyMessage}</CommandEmpty> : null}
            {activeScope === null ? (
              <CommandGroup heading="Actions">
                {actions.map((action) => (
                  <CommandItem
                    key={action.id}
                    value={`action ${action.label} ${action.keywords.join(" ")}`}
                    className="gap-3 rounded-lg px-3 py-2.5"
                    onSelect={() => runAction(action.id)}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <AppActionIcon actionId={action.id} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {action.label}
                    </span>
                    {action.shortcut ? (
                      <kbd className="shrink-0 rounded border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {action.shortcut.label}
                      </kbd>
                    ) : (
                      <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : activeScope === "new-project" ? (
              <>
                <CommandGroup heading="Source">
                  <CommandItem
                    value="github git repository clone new project"
                    className="gap-3 rounded-lg px-3 py-2.5"
                    onSelect={() => armScope("github")}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <FolderGit2 className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">GitHub</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Clone a repository available to your worker
                      </span>
                    </span>
                    <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                  </CommandItem>
                  <CommandItem
                    value="folder directory new open attach project"
                    className="gap-3 rounded-lg px-3 py-2.5"
                    onSelect={() => armScope("folder")}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Folder className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Folder</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Create an empty folder or attach an existing one
                      </span>
                    </span>
                    <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                  </CommandItem>
                </CommandGroup>
                {projects.length > 0 ? (
                  <CommandGroup heading="Existing projects">
                    {projects.map((project) => {
                      const memberships = projectMemberships(
                        project.id,
                        workspaces,
                      );
                      const detail = projectDetail(project, memberships);
                      const current = project.id === currentProjectId;
                      return (
                        <CommandItem
                          key={project.id}
                          value={`project ${project.name} ${detail} ${project.id}`}
                          className="gap-3 rounded-lg px-3 py-2.5"
                          onSelect={() => selectProject(project.id)}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                            {project.originKind === "github" ? (
                              <FolderGit2 className="size-4" />
                            ) : (
                              <Folder className="size-4" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {project.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {detail}
                            </span>
                          </span>
                          {project.setupStatus !== "ready" ? (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                              {project.setupStatus}
                            </span>
                          ) : current ? (
                            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                              <Check className="size-3" /> Current
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}
              </>
            ) : activeScope === "folder" ? (
              <CommandGroup heading="Folder project">
                {query.trim() ? (
                  <CommandItem
                    value={`${query} create new empty folder project`}
                    disabled={Boolean(
                      folderSubmitting || !folderWorker || !activeWorkspaceId,
                    )}
                    className="gap-3 rounded-lg px-3 py-2.5"
                    onSelect={() => void createFolder()}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Plus className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        Create “{query.trim()}”
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {folderWorker && activeWorkspaceId
                          ? `New empty folder on ${folderWorker.name}`
                          : "No online folder-capable worker is available"}
                      </span>
                    </span>
                    {folderSubmitting ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </CommandItem>
                ) : null}
                <CommandItem
                  value="open existing folder directory browse attach"
                  className="gap-3 rounded-lg px-3 py-2.5"
                  onSelect={() => {
                    onOpenChange(false);
                    onOpenFolder();
                  }}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <FolderOpen className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">Open Folder</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      Browse this machine or enter a path on a worker
                    </span>
                  </span>
                  <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                {!githubWorkerId ? (
                  <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-muted-foreground">
                    Start an online worker to load GitHub repositories.
                  </div>
                ) : githubLoading ? (
                  <div className="grid min-h-28 place-items-center text-sm text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" /> Loading GitHub
                      repositories…
                    </span>
                  </div>
                ) : github.isError ? (
                  <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-destructive">
                    {errorMessage(github.error)}
                  </div>
                ) : github.data && !github.data.authenticated ? (
                  <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-muted-foreground">
                    Connect GitHub on {githubWorkerId} to list repositories.
                  </div>
                ) : repositories.isError && !hasGithubRepositoryData ? (
                  <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-destructive">
                    {errorMessage(repositories.error)}
                  </div>
                ) : (
                  <CommandGroup heading="GitHub repositories">
                    {githubRepositories.map((repository) => {
                      const existingProject = projects.find(
                        (project) =>
                          project.github?.repositoryId === repository.id,
                      );
                      const imported = Boolean(
                        repository.imported || existingProject,
                      );
                      const pending = pendingRepositoryId === repository.id;
                      return (
                        <CommandItem
                          key={repository.id}
                          value={`${repository.nameWithOwner} ${repository.description ?? ""} github repository`}
                          disabled={Boolean(
                            imported ||
                            pendingRepositoryId ||
                            !activeWorkspaceId,
                          )}
                          className="gap-3 rounded-lg px-3 py-2.5"
                          onSelect={() => void importRepository(repository)}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                            <RepositoryIcon repository={repository} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {repository.nameWithOwner}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {repository.description ??
                                (repository.isPrivate
                                  ? "Private repository"
                                  : "Public repository")}
                            </span>
                          </span>
                          {pending ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                          ) : imported ? (
                            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                              <Check className="size-3" /> Added
                            </span>
                          ) : (
                            <Plus className="size-4 shrink-0 text-muted-foreground" />
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-t px-4 text-[11px] text-muted-foreground">
          <span
            className={
              operationError ? "truncate text-destructive" : "truncate"
            }
            title={operationError ?? undefined}
          >
            {operationError ??
              (scopes.length > 0
                ? "Backspace on an empty search removes the previous action"
                : "Actions adapt to the current view")}
          </span>
          <span className="hidden shrink-0 items-center gap-3 sm:flex">
            <span>↑↓ Navigate</span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" /> Select
            </span>
            <span>esc Close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
