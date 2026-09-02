import type {
  GithubRepository,
  ProjectSummary,
  ProjectWorkspaceSummary,
  ScriptCommand,
  WorkerSummary,
} from "@cantrip/protocol";
import { isWorkerBoundFolderProject } from "@cantrip/protocol";
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
  MapPin,
  Palette,
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
  getProjectScriptCommands,
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
import {
  RepositoryImportOptionsDialog,
  type RepositoryImportOptions,
} from "@/components/projects/repository-import-options-dialog";
import { resolveProjectWorkspaceForSelection } from "@/lib/project-workspaces";

const scopeLabels: Record<CommandBarScope, string> = {
  folder: "Folder",
  github: "GitHub",
  "new-project": "New Project",
};

function projectWorkspace(
  projectId: string,
  workspaces: readonly ProjectWorkspaceSummary[],
): ProjectWorkspaceSummary | null {
  return (
    workspaces.find(({ projectIds }) => projectIds.includes(projectId)) ?? null
  );
}

function projectDetail(
  project: ProjectSummary,
  workspace: ProjectWorkspaceSummary | null,
): string {
  const source =
    project.source?.displayPath ??
    project.github?.nameWithOwner ??
    (isWorkerBoundFolderProject(project.originKind, project.capabilities.git)
      ? "Worker-bound folder"
      : "GitHub repository");
  return workspace ? `${source} · ${workspace.name}` : source;
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

function ProjectCommandGroup({
  currentProjectId,
  heading,
  onSelect,
  projects,
  workspaces,
}: {
  currentProjectId: string | null;
  heading: string;
  onSelect(project: ProjectSummary): void;
  projects: readonly ProjectSummary[];
  workspaces: readonly ProjectWorkspaceSummary[];
}) {
  return (
    <CommandGroup heading={heading}>
      {projects.map((project) => {
        const workspace = projectWorkspace(project.id, workspaces);
        const detail = projectDetail(project, workspace);
        const current = project.id === currentProjectId;
        return (
          <CommandItem
            key={project.id}
            value={`${project.name} ${detail} ${project.id} project`}
            className="gap-3 rounded-lg px-3 py-2.5"
            onSelect={() => onSelect(project)}
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
  onRunScriptCommand,
  onSelectProject,
  open,
  projects,
  scriptWorktreeId,
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
  onRunScriptCommand(command: ScriptCommand): Promise<void>;
  onSelectProject(projectId: string): void;
  open: boolean;
  projects: readonly ProjectSummary[];
  scriptWorktreeId: string | null;
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
  const [customRepository, setCustomRepository] =
    useState<GithubRepository | null>(null);
  const [pendingScriptCommandId, setPendingScriptCommandId] = useState<
    string | null
  >(null);
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
  const projectScriptCommands = useQuery({
    enabled: Boolean(open && activeScope === null && currentProjectId),
    queryFn: () =>
      getProjectScriptCommands(
        currentProjectId!,
        scriptWorktreeId ?? undefined,
      ),
    queryKey: [
      "project-script-commands",
      currentProjectId,
      scriptWorktreeId ?? "default",
    ],
    refetchOnWindowFocus: false,
    staleTime: 10_000,
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
  const selectProject = (project: ProjectSummary) => {
    const workspace = resolveProjectWorkspaceForSelection(
      workspaces,
      project.id,
    );
    if (!workspace) {
      setOperationError(
        `Project “${project.name}” is not assigned to any workspace.`,
      );
      return;
    }
    onSelectProject(project.id);
    onOpenChange(false);
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
        workspaceId: activeWorkspaceId,
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
  const importRepository = async (
    repository: GithubRepository,
    options?: RepositoryImportOptions,
  ) => {
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
        ...(options?.placement ? { placement: options.placement } : {}),
        workspaceId: activeWorkspaceId,
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
      throw error;
    } finally {
      setPendingRepositoryId(null);
    }
  };
  const runScriptCommand = async (command: ScriptCommand) => {
    if (pendingScriptCommandId) return;
    setPendingScriptCommandId(command.id);
    setOperationError(null);
    try {
      await onRunScriptCommand(command);
      onOpenChange(false);
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setPendingScriptCommandId(null);
    }
  };

  const placeholder =
    activeScope === "folder"
      ? "Type a project name or open a folder…"
      : activeScope === "github"
        ? "Search GitHub repositories…"
        : activeScope === "new-project"
          ? "Choose a source or existing project…"
          : "Search actions, scripts, or projects…";
  const emptyMessage =
    activeScope === "github"
      ? "No GitHub repositories match your search."
      : activeScope === "new-project"
        ? "No projects match your search."
        : "No matching actions, scripts, or projects.";
  const showEmpty = !(
    activeScope === "github" &&
    (githubLoading ||
      !githubWorkerId ||
      github.isError ||
      (github.data && !github.data.authenticated) ||
      (repositories.isError && !hasGithubRepositoryData))
  );

  const githubWorker =
    workers.find(({ workerId }) => workerId === githubWorkerId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-elite-ignore=""
        className="self-start flex max-h-[70vh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
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
              onValueChange={(value) => {
                setQuery(value);
                setOperationError(null);
              }}
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
              <>
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
                {currentProjectId ? (
                  <CommandGroup heading="Project scripts">
                    {projectScriptCommands.isPending ? (
                      <CommandItem disabled value="discovering project scripts">
                        <Loader2 className="size-4 animate-spin" />
                        <span className="text-sm text-muted-foreground">
                          Discovering scripts…
                        </span>
                      </CommandItem>
                    ) : projectScriptCommands.isError ? (
                      <CommandItem disabled value="project scripts unavailable">
                        <Palette className="size-4" />
                        <span className="truncate text-sm text-destructive">
                          {errorMessage(projectScriptCommands.error)}
                        </span>
                      </CommandItem>
                    ) : (
                      projectScriptCommands.data?.map((command) => {
                        const pending = pendingScriptCommandId === command.id;
                        return (
                          <CommandItem
                            key={command.id}
                            value={`project script task ${command.name} ${command.command} ${command.source} ${command.description ?? ""}`}
                            disabled={Boolean(pendingScriptCommandId)}
                            className="gap-3 rounded-lg px-3 py-2.5"
                            onSelect={() => void runScriptCommand(command)}
                          >
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                              <Palette className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                  {command.name}
                                </span>
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {command.source}
                                </span>
                              </span>
                              <span className="block truncate font-mono text-xs text-muted-foreground">
                                {command.command}
                              </span>
                              {command.description ? (
                                <span className="block truncate text-[11px] text-muted-foreground/80">
                                  {command.description}
                                </span>
                              ) : null}
                            </span>
                            {pending ? (
                              <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                              <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                          </CommandItem>
                        );
                      })
                    )}
                  </CommandGroup>
                ) : null}
                {projects.length > 0 ? (
                  <ProjectCommandGroup
                    currentProjectId={currentProjectId}
                    heading="Projects"
                    projects={projects}
                    workspaces={workspaces}
                    onSelect={selectProject}
                  />
                ) : null}
              </>
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
                  <ProjectCommandGroup
                    currentProjectId={currentProjectId}
                    heading="Existing projects"
                    projects={projects}
                    workspaces={workspaces}
                    onSelect={selectProject}
                  />
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
                          onSelect={() =>
                            void importRepository(repository).catch(
                              () => undefined,
                            )
                          }
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
                            <span className="flex shrink-0 items-center gap-1">
                              <Plus className="size-4 text-muted-foreground" />
                              <button
                                aria-label={`Add ${repository.nameWithOwner} with location`}
                                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                title="Add with location"
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setCustomRepository(repository);
                                  onOpenChange(false);
                                }}
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                              >
                                <MapPin className="size-3.5" />
                              </button>
                            </span>
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
          {operationError ? (
            <span className="flex min-w-0 items-center gap-1 text-destructive">
              <span className="truncate" title={operationError}>
                {operationError}
              </span>
              <button
                aria-label="Dismiss command error"
                className="grid size-5 shrink-0 place-items-center rounded hover:bg-destructive/10"
                onClick={() => setOperationError(null)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </span>
          ) : (
            <span className="truncate">
              {scopes.length > 0
                ? "Backspace on an empty search removes the previous action"
                : "Search actions, project scripts, and projects from any workspace"}
            </span>
          )}
          <span className="hidden shrink-0 items-center gap-3 sm:flex">
            <span>↑↓ Navigate</span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" /> Select
            </span>
            <span>esc Close</span>
          </span>
        </div>
      </DialogContent>
      <RepositoryImportOptionsDialog
        error={operationError}
        open={Boolean(customRepository)}
        pending={Boolean(pendingRepositoryId)}
        repositoryName={customRepository?.nameWithOwner ?? "repository"}
        workspaceId={activeWorkspaceId ?? undefined}
        worker={githubWorker}
        workspaces={[...workspaces]}
        onOpenChange={(next) => !next && setCustomRepository(null)}
        onSubmit={async (options) => {
          if (!customRepository) return;
          await importRepository(customRepository, options);
          setCustomRepository(null);
        }}
      />
    </Dialog>
  );
}
