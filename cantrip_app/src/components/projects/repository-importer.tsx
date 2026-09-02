import type {
  GithubRepository,
  ProjectReplicaJobSummary,
  ProjectSummary,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";

import { StatusDot } from "@/components/app/status-dot";
import { GithubRepositoryCreateDialog } from "@/components/projects/github-repository-create-dialog";
import {
  RepositoryImportOptionsDialog,
  type RepositoryImportOptions,
} from "@/components/projects/repository-import-options-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkspaceAssignment } from "@/components/workspaces/workspace-assignment";
import {
  getCachedGithubRepositories,
  getGithubRepositories,
  getGithubStatus,
} from "@/lib/api";
import { errorMessage as errorText } from "@/lib/error-message";
import { projectSetupErrorMessage } from "@/lib/job-status-message";
import { createGithubProject } from "@/lib/project-encryption";
import { cn } from "@/lib/utils";

export const REPOSITORY_IMPORT_PAGE_SIZE = 100;
export const REPOSITORY_IMPORT_LOAD_THRESHOLD_PX = 480;

export function nextRepositoryImportRenderCount(
  current: number,
  total: number,
): number {
  return Math.min(total, current + REPOSITORY_IMPORT_PAGE_SIZE);
}

export function shouldLoadMoreRepositories(input: {
  clientHeight: number;
  renderedCount: number;
  scrollHeight: number;
  scrollTop: number;
  totalCount: number;
}): boolean {
  return (
    input.renderedCount < input.totalCount &&
    input.scrollHeight - input.clientHeight - input.scrollTop <=
      REPOSITORY_IMPORT_LOAD_THRESHOLD_PX
  );
}

export function RepositoryImporter({
  activeWorkspaceId,
  onCreatedProject,
  projectSetupJobs,
  projects,
  workerId,
  workers,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  onCreatedProject(project: ProjectSummary): void;
  projectSetupJobs: ReadonlyMap<string, ProjectReplicaJobSummary>;
  projects: ProjectSummary[];
  workerId: string | null;
  workers: WorkerSummary[];
  workspaces: ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [renderedRepositoryCount, setRenderedRepositoryCount] = useState(
    REPOSITORY_IMPORT_PAGE_SIZE,
  );
  const [createRepositoryOpen, setCreateRepositoryOpen] = useState(false);
  const [customRepository, setCustomRepository] =
    useState<GithubRepository | null>(null);
  const [pendingRepositoryIds, setPendingRepositoryIds] = useState<Set<string>>(
    new Set(),
  );
  const pendingRepositoryIdsRef = useRef(new Set<string>());
  const repositoryListRef = useRef<HTMLDivElement>(null);
  const [importErrors, setImportErrors] = useState<Map<string, string>>(
    new Map(),
  );
  useEffect(() => {
    setRenderedRepositoryCount(REPOSITORY_IMPORT_PAGE_SIZE);
    repositoryListRef.current?.scrollTo({ top: 0 });
  }, [workerId]);
  const github = useQuery({
    enabled: Boolean(workerId),
    queryFn: () => getGithubStatus(workerId!),
    queryKey: ["github-status", workerId],
  });
  const repositories = useQuery({
    enabled: Boolean(workerId && github.data?.authenticated),
    queryFn: () => getGithubRepositories(workerId!),
    queryKey: ["github-repositories", workerId],
  });
  const cachedRepositories = useQuery({
    enabled: Boolean(
      workerId && github.data?.authenticated && github.data.login,
    ),
    queryFn: () => getCachedGithubRepositories(workerId!, github.data!.login!),
    queryKey: ["github-repositories-cache", workerId, github.data?.login],
    staleTime: 30_000,
  });
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
  const importRepository = async (
    repository: GithubRepository,
    options?: RepositoryImportOptions,
  ) => {
    if (
      !workerId ||
      !activeWorkspaceId ||
      pendingRepositoryIdsRef.current.has(repository.id)
    )
      throw new Error("The repository cannot be added right now.");
    pendingRepositoryIdsRef.current.add(repository.id);
    setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
    setImportErrors((current) => {
      const next = new Map(current);
      next.delete(repository.id);
      return next;
    });

    try {
      const project = await createGithubProject({
        workerId,
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
      markImported(["github-repositories", workerId]);
      if (github.data?.login) {
        markImported([
          "github-repositories-cache",
          workerId,
          github.data.login,
        ]);
      }
      return project;
    } catch (error) {
      setImportErrors((current) =>
        new Map(current).set(repository.id, errorText(error)),
      );
      throw error;
    } finally {
      pendingRepositoryIdsRef.current.delete(repository.id);
      setPendingRepositoryIds(new Set(pendingRepositoryIdsRef.current));
    }
  };
  const queueImport = (repository: GithubRepository) => {
    void importRepository(repository)
      .then(onCreatedProject)
      .catch(() => undefined);
  };
  const rememberRepository = (repository: GithubRepository) => {
    const addRepository = (queryKey: readonly unknown[]) =>
      queryClient.setQueryData<GithubRepository[]>(queryKey, (current = []) => [
        repository,
        ...current.filter((item) => item.id !== repository.id),
      ]);
    addRepository(["github-repositories", workerId]);
    if (github.data?.login) {
      addRepository(["github-repositories-cache", workerId, github.data.login]);
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (repositories.data ?? cachedRepositories.data ?? []).filter(
      (repository) =>
        needle
          ? `${repository.nameWithOwner} ${repository.description ?? ""}`
              .toLowerCase()
              .includes(needle)
          : true,
    );
  }, [cachedRepositories.data, repositories.data, search]);
  const visibleRepositories = useMemo(
    () => filtered.slice(0, renderedRepositoryCount),
    [filtered, renderedRepositoryCount],
  );
  const loadMoreRepositories = () => {
    setRenderedRepositoryCount((current) =>
      nextRepositoryImportRenderCount(current, filtered.length),
    );
  };
  const handleRepositoryScroll = (event: UIEvent<HTMLDivElement>) => {
    const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
    if (
      shouldLoadMoreRepositories({
        clientHeight,
        renderedCount: visibleRepositories.length,
        scrollHeight,
        scrollTop,
        totalCount: filtered.length,
      })
    ) {
      loadMoreRepositories();
    }
  };
  const hasRepositoryData = Boolean(
    repositories.data || cachedRepositories.data?.length,
  );
  const repositoryPickerReady = Boolean(
    workerId && github.data?.authenticated && !github.isError,
  );
  const selectedWorker =
    workers.find((worker) => worker.workerId === workerId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-content-gutter="roomy"
        className={cn(
          "flex w-full flex-1 flex-col overflow-hidden",
          !repositoryPickerReady && "p-5 sm:p-8",
        )}
      >
        {!workerId ? (
          <Card>
            <CardHeader>
              <CardTitle>No worker available</CardTitle>
              <CardDescription>
                Start the local worker before importing a repository.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : github.isLoading && !github.data ? (
          <div className="grid flex-1 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : github.isError ? (
          <Card>
            <CardHeader>
              <CardTitle>Unable to reach GitHub through the worker</CardTitle>
              <CardDescription className="max-w-xl leading-6 text-destructive">
                {errorText(github.error)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void github.refetch()}>
                <RefreshCw className="size-4" />
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : !github.data?.authenticated ? (
          <Card>
            <CardHeader>
              <div className="mb-2 grid size-10 place-items-center rounded-lg border">
                <GitBranch className="size-5" />
              </div>
              <CardTitle>Connect GitHub on the worker</CardTitle>
              <CardDescription className="max-w-xl leading-6">
                For the local MVP, Cantrip reuses GitHub CLI authentication. Run{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">
                  gh auth login
                </code>{" "}
                or start the worker with a fine-grained token in{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">GH_TOKEN</code>
                . The credential never enters the browser or server database.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => void github.refetch()}>
                <RefreshCw className="size-4" />
                Check again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-4 px-5 pt-5 sm:px-8 sm:pt-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setRenderedRepositoryCount(REPOSITORY_IMPORT_PAGE_SIZE);
                      repositoryListRef.current?.scrollTo({ top: 0 });
                    }}
                    placeholder="Search repositories"
                    className="h-10 w-full rounded-md border bg-background pl-10 pr-3 text-sm outline-none ring-ring focus:ring-2"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <Badge variant="secondary" className="gap-2 px-3 py-2">
                    <StatusDot online />@{github.data.login}
                  </Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {filtered.length} repositories
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={repositories.isFetching}
                    onClick={() => void repositories.refetch()}
                  >
                    <RefreshCw
                      className={cn(
                        "size-4",
                        repositories.isFetching && "animate-spin",
                      )}
                    />
                    {repositories.isFetching ? "Refreshing" : "Refresh"}
                  </Button>
                </div>
              </div>

              {activeWorkspaceId ? (
                <WorkspaceAssignment
                  workspaceId={activeWorkspaceId}
                  trailingAction={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCreateRepositoryOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      Repository
                    </Button>
                  }
                  workspaces={workspaces}
                />
              ) : null}
            </div>

            {!hasRepositoryData &&
            (repositories.isLoading || cachedRepositories.isLoading) ? (
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Loading repositories…
                </div>
              </div>
            ) : repositories.isError && !hasRepositoryData ? (
              <p className="mx-5 mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive sm:mx-8">
                {errorText(repositories.error)}
              </p>
            ) : (
              <div
                className="mt-4 min-h-0 flex-1 overflow-auto border-y"
                ref={repositoryListRef}
                onScroll={handleRepositoryScroll}
              >
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <thead
                    data-slot="table-header-surface"
                    className="sticky top-0 z-10 bg-background/95 text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur-xl"
                  >
                    <tr className="border-b">
                      <th className="w-[42%] px-3 py-2 font-medium sm:w-[34%]">
                        Repository
                      </th>
                      <th className="hidden w-[34%] px-3 py-2 font-medium md:table-cell">
                        Description
                      </th>
                      <th className="hidden w-24 px-3 py-2 font-medium sm:table-cell">
                        Type
                      </th>
                      <th className="hidden w-28 px-3 py-2 font-medium lg:table-cell">
                        Updated
                      </th>
                      <th className="w-36 px-3 py-2 text-right font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRepositories.map((repository) => {
                      const project = projects.find(
                        (candidate) =>
                          candidate.github?.repositoryId === repository.id,
                      );
                      const importing =
                        pendingRepositoryIds.has(repository.id) ||
                        project?.setupStatus === "cloning";
                      const failed = project?.setupStatus === "failed";
                      const setupJob = project
                        ? projectSetupJobs.get(project.id)
                        : undefined;
                      const disabled = Boolean(
                        !activeWorkspaceId ||
                        repository.imported ||
                        project ||
                        importing,
                      );
                      const importError =
                        projectSetupErrorMessage(project?.setupError ?? null) ??
                        importErrors.get(repository.id);
                      return (
                        <tr
                          key={repository.id}
                          role="button"
                          tabIndex={disabled ? -1 : 0}
                          aria-disabled={disabled}
                          title={importError}
                          onClick={() => {
                            if (!disabled) queueImport(repository);
                          }}
                          onKeyDown={(event) => {
                            if (
                              !disabled &&
                              (event.key === "Enter" || event.key === " ")
                            ) {
                              event.preventDefault();
                              queueImport(repository);
                            }
                          }}
                          className={cn(
                            "h-10 outline-none odd:bg-muted/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            disabled
                              ? "cursor-default text-muted-foreground"
                              : "cursor-pointer hover:bg-muted/40",
                          )}
                        >
                          <td className="px-3 py-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                              {repository.isPrivate ? (
                                <Lock className="size-3.5 shrink-0" />
                              ) : repository.isFork ? (
                                <GitFork className="size-3.5 shrink-0" />
                              ) : (
                                <FolderGit2 className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate font-medium">
                                {repository.nameWithOwner}
                              </span>
                            </div>
                          </td>
                          <td className="hidden truncate px-3 py-1.5 text-xs text-muted-foreground md:table-cell">
                            {repository.description ?? "No description"}
                          </td>
                          <td className="hidden px-3 py-1.5 text-xs text-muted-foreground sm:table-cell">
                            {repository.isPrivate
                              ? "Private"
                              : repository.isFork
                                ? "Fork"
                                : "Public"}
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground lg:table-cell">
                            {new Date(repository.updatedAt).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </td>
                          <td className="px-3 py-1 text-right text-xs">
                            <span className="inline-flex items-center justify-end gap-1">
                              {failed ? (
                                <CircleAlert className="size-3.5 text-destructive" />
                              ) : importing ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : repository.imported ? (
                                <Check className="size-3.5" />
                              ) : (
                                <Plus className="size-3.5" />
                              )}
                              {failed || importing || repository.imported ? (
                                failed ? (
                                  "Failed"
                                ) : importing ? (
                                  setupJob ? (
                                    `${setupJob.progress.percent}%`
                                  ) : (
                                    "Starting"
                                  )
                                ) : (
                                  "Added"
                                )
                              ) : (
                                <>
                                  <Button
                                    className="h-7 px-2 text-xs"
                                    size="sm"
                                    variant="ghost"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      queueImport(repository);
                                    }}
                                  >
                                    Add
                                  </Button>
                                  <Button
                                    aria-label={`Add ${repository.nameWithOwner} with location`}
                                    className="size-7"
                                    size="icon"
                                    title="Add with location"
                                    variant="ghost"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setCustomRepository(repository);
                                    }}
                                  >
                                    <MoreHorizontal className="size-3.5" />
                                  </Button>
                                </>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {visibleRepositories.length < filtered.length ? (
                  <div className="flex items-center justify-center gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                    <span>
                      Showing {visibleRepositories.length} of {filtered.length}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={loadMoreRepositories}
                    >
                      Show more
                    </Button>
                  </div>
                ) : null}
                {filtered.length === 0 ? (
                  <div className="grid min-h-40 place-items-center p-8 text-center text-sm text-muted-foreground">
                    No matching repositories.
                  </div>
                ) : null}
              </div>
            )}

            {(repositories.isError && hasRepositoryData) ||
            importErrors.size > 0 ? (
              <div className="flex shrink-0 flex-col gap-3 px-5 pb-5 pt-4 sm:px-8 sm:pb-8">
                {repositories.isError && hasRepositoryData ? (
                  <p className="text-xs text-destructive">
                    Refresh failed; showing the last cached repository list.{" "}
                    {errorText(repositories.error)}
                  </p>
                ) : null}
                {importErrors.size > 0 ? (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {Array.from(importErrors.values()).at(-1)}
                  </p>
                ) : null}
              </div>
            ) : null}

            <GithubRepositoryCreateDialog
              login={github.data.login!}
              open={createRepositoryOpen}
              workerId={workerId}
              onOpenChange={setCreateRepositoryOpen}
              onCreated={async (repository) => {
                rememberRepository(repository);
                setCustomRepository(repository);
              }}
            />
            <RepositoryImportOptionsDialog
              error={
                customRepository
                  ? (importErrors.get(customRepository.id) ?? null)
                  : null
              }
              open={Boolean(customRepository)}
              pending={Boolean(
                customRepository &&
                pendingRepositoryIds.has(customRepository.id),
              )}
              repositoryName={customRepository?.nameWithOwner ?? "repository"}
              workspaceId={activeWorkspaceId ?? undefined}
              worker={selectedWorker}
              workspaces={workspaces}
              onOpenChange={(open) => !open && setCustomRepository(null)}
              onSubmit={async (options) => {
                if (!customRepository) return;
                const project = await importRepository(
                  customRepository,
                  options,
                );
                setCustomRepository(null);
                onCreatedProject(project);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
