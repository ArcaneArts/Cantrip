import type {
  GithubRepository,
  ProjectGithubConversionPreflightReady,
  ProjectGithubConversionPreflightResult,
  ProjectSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { GithubRepositoryCreateDialog } from "@/components/projects/github-repository-create-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  getGithubRepositories,
  getGithubStatus,
  getProjectGithubConversion,
  preflightProjectGithubConversion,
  retryProjectGithubConversion,
  startProjectGithubConversion,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { projectGithubConversionJobMessage } from "@/lib/job-status-message";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";

function errorText(error: unknown): string {
  return errorMessage(error, "The GitHub conversion could not continue.");
}

export function githubConversionCanStart(input: {
  confirmedInitialCommit: boolean;
  confirmedRepository: boolean;
  preflight: ProjectGithubConversionPreflightResult | null;
}): boolean {
  return Boolean(
    input.preflight?.status === "ready" &&
    input.confirmedRepository &&
    (!input.preflight.requiresInitialCommit || input.confirmedInitialCommit),
  );
}

function LocalState({
  preflight,
}: {
  preflight: ProjectGithubConversionPreflightReady;
}) {
  const label =
    preflight.localState === "not-initialized"
      ? "No local Git repository"
      : preflight.localState === "unborn"
        ? "Git initialized with no commits"
        : `Branch ${preflight.branch ?? "unknown"} at ${preflight.head?.slice(0, 8)}`;
  return (
    <div className="rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="font-medium">{label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {preflight.dirty
          ? preflight.head
            ? "Uncommitted changes will remain local and will not be added to the push."
            : "The current folder contents require an explicitly approved initial commit."
          : "The local working state passed conversion preflight."}
      </div>
    </div>
  );
}

export function ProjectGithubConversion({
  project,
  workers,
}: {
  project: ProjectSummary;
  workers: WorkerSummary[];
}) {
  const queryClient = useQueryClient();
  const conversionResourcesLive = useAppLiveStatus() === "live";
  const [open, setOpen] = useState(false);
  const [createRepositoryOpen, setCreateRepositoryOpen] = useState(false);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [preflight, setPreflight] =
    useState<ProjectGithubConversionPreflightResult | null>(null);
  const [confirmedRepository, setConfirmedRepository] = useState(false);
  const [confirmedInitialCommit, setConfirmedInitialCommit] = useState(false);
  const [commitMessage, setCommitMessage] = useState("Initial commit");
  const workerId =
    project.source?.workerId ?? project.preferredWorkerId ?? null;
  const worker = workers.find((candidate) => candidate.workerId === workerId);
  const conversion = useQuery({
    enabled: project.originKind === "managed-folder",
    queryFn: () => getProjectGithubConversion(project.id),
    queryKey: ["project-github-conversion", project.id],
    refetchInterval: (query) => {
      const job = query.state.data;
      return liveResourceRefreshInterval(
        conversionResourcesLive,
        job && ["queued", "running"].includes(job.state) ? 2_000 : false,
      );
    },
    retry: false,
  });
  const github = useQuery({
    enabled: open && Boolean(workerId && worker?.online),
    queryFn: () => getGithubStatus(workerId!),
    queryKey: ["github-status", workerId],
  });
  const repositories = useQuery({
    enabled: open && Boolean(workerId && github.data?.authenticated),
    queryFn: () => getGithubRepositories(workerId!),
    queryKey: ["github-repositories", workerId],
  });
  const availableRepositories = useMemo(
    () =>
      (repositories.data ?? []).filter((repository) => !repository.imported),
    [repositories.data],
  );
  const selectedRepository = availableRepositories.find(
    ({ id }) => id === selectedRepositoryId,
  );

  useEffect(() => {
    if (
      selectedRepositoryId &&
      availableRepositories.some(({ id }) => id === selectedRepositoryId)
    ) {
      return;
    }
    setSelectedRepositoryId(availableRepositories[0]?.id ?? "");
  }, [availableRepositories, selectedRepositoryId]);

  const resetConfirmation = () => {
    setPreflight(null);
    setConfirmedRepository(false);
    setConfirmedInitialCommit(false);
  };
  const runPreflight = useMutation({
    mutationFn: (repository: GithubRepository) =>
      preflightProjectGithubConversion(project.id, {
        repository: {
          repositoryId: repository.id,
          nameWithOwner: repository.nameWithOwner,
          url: repository.url,
        },
      }),
    onSuccess: (result) => {
      setPreflight(result);
      setConfirmedRepository(false);
      setConfirmedInitialCommit(false);
    },
  });
  const start = useMutation({
    mutationFn: async (ready: ProjectGithubConversionPreflightReady) =>
      startProjectGithubConversion(project.id, {
        repository: ready.repository,
        confirmationToken: ready.confirmationToken,
        initialCommit: ready.requiresInitialCommit
          ? { message: commitMessage }
          : null,
      }),
    onSuccess: (job) => {
      queryClient.setQueryData(["project-github-conversion", project.id], job);
      setOpen(false);
      resetConfirmation();
    },
  });
  const retry = useMutation({
    mutationFn: (stateRevision: number) =>
      retryProjectGithubConversion(project.id, stateRevision),
    onSuccess: (job) => {
      queryClient.setQueryData(["project-github-conversion", project.id], job);
    },
  });
  const job = conversion.data;
  const active = Boolean(
    job && ["queued", "running", "blocked"].includes(job.state),
  );
  const canOpen = Boolean(
    worker?.online && worker.managedFolders.convertToGithub && !active,
  );

  return (
    <section aria-labelledby="github-conversion-title">
      <div className="mb-3">
        <h2 id="github-conversion-title" className="font-semibold">
          GitHub conversion
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Explicitly initialize or reconcile Git, push a new history, and link
          this project to one empty GitHub repository.
        </p>
      </div>
      <div className="rounded-lg border p-4">
        {job && active ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="mt-0.5">
                {job.error?.code === "worker-offline" ? (
                  <WifiOff className="size-5 text-amber-500" />
                ) : job.state === "queued" || job.state === "running" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <CircleAlert className="size-5 text-amber-500" />
                )}
              </div>
              <div>
                <div className="font-medium">
                  {job.state === "queued"
                    ? "Conversion queued"
                    : job.state === "running"
                      ? "Converting and pushing…"
                      : "Conversion waiting"}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {job.error
                    ? projectGithubConversionJobMessage(job)
                    : job.repository.nameWithOwner}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Git features remain disabled until worker reconciliation and
                  the database transition both complete.
                </div>
              </div>
            </div>
            {job.state === "blocked" && job.error?.retryable ? (
              <Button
                disabled={retry.isPending}
                size="sm"
                variant="outline"
                onClick={() => retry.mutate(job.stateRevision)}
              >
                {retry.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Retry
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 font-medium">
                <FolderGit2 className="size-4" /> Convert to GitHub project
              </div>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Running <code className="rounded bg-muted px-1">git init</code>{" "}
                never changes project mode. Conversion is one-way in V1 and
                preserves this project&apos;s ID, chats, Tasks, tabs, settings,
                and folder path.
              </p>
              {job?.state === "failed" && job.error ? (
                <p className="mt-2 text-sm text-destructive">
                  Previous attempt: {projectGithubConversionJobMessage(job)}
                </p>
              ) : null}
              {!worker?.online ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  The owning worker must be online.
                </p>
              ) : worker && !worker.managedFolders.convertToGithub ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  Update the owning worker before converting this folder.
                </p>
              ) : null}
            </div>
            <Button disabled={!canOpen} onClick={() => setOpen(true)}>
              <GitBranch className="size-4" /> Convert to GitHub
            </Button>
          </div>
        )}
        {retry.isError ? (
          <p className="mt-3 text-sm text-destructive">
            {errorText(retry.error)}
          </p>
        ) : null}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (start.isPending) return;
          setOpen(next);
          if (!next) resetConfirmation();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Convert {project.name} to GitHub?</DialogTitle>
            <DialogDescription>
              Select the exact empty repository, run worker preflight, then
              separately confirm the irreversible transition.
            </DialogDescription>
          </DialogHeader>

          {!github.data?.authenticated ? (
            <div className="rounded-lg border p-4 text-sm">
              {github.isLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Checking GitHub
                  authentication…
                </span>
              ) : (
                <>
                  GitHub is not authenticated on the owning worker. Run{" "}
                  <code className="rounded bg-muted px-1">gh auth login</code>{" "}
                  there, then reopen this dialog.
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-end gap-2">
                <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-medium">
                  GitHub repository
                  <NativeSelect
                    className="h-10 w-full rounded-md border bg-background px-3 font-normal outline-none ring-ring focus:ring-2"
                    disabled={runPreflight.isPending || start.isPending}
                    value={selectedRepositoryId}
                    onChange={(event) => {
                      setSelectedRepositoryId(event.target.value);
                      resetConfirmation();
                    }}
                  >
                    {availableRepositories.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.nameWithOwner}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button
                  disabled={runPreflight.isPending || start.isPending}
                  type="button"
                  variant="outline"
                  onClick={() => setCreateRepositoryOpen(true)}
                >
                  <Plus className="size-4" /> New empty
                </Button>
              </div>
              {repositories.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading repositories…
                </p>
              ) : availableRepositories.length === 0 ? (
                <p className="rounded-lg border p-3 text-sm text-muted-foreground">
                  No unbound repository is available. Create a new empty one to
                  continue.
                </p>
              ) : null}
              {!preflight ? (
                <Button
                  disabled={!selectedRepository || runPreflight.isPending}
                  type="button"
                  onClick={() => {
                    if (selectedRepository)
                      runPreflight.mutate(selectedRepository);
                  }}
                >
                  {runPreflight.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Run safety preflight
                </Button>
              ) : preflight.status === "blocked" ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <div className="flex items-center gap-2 font-medium text-destructive">
                    <CircleAlert className="size-4" /> Conversion blocked
                  </div>
                  <p className="mt-2 text-sm">{preflight.error.message}</p>
                  <Button
                    className="mt-3"
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={resetConfirmation}
                  >
                    Choose another repository
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium">
                          {preflight.repository.nameWithOwner}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Empty repository verified by the owning worker
                        </div>
                      </div>
                      <a
                        aria-label="Open selected GitHub repository"
                        href={preflight.repository.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </div>
                  </div>
                  <LocalState preflight={preflight} />
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {preflight.warnings.map((warning) => (
                      <li key={warning}>• {warning}</li>
                    ))}
                  </ul>
                  {preflight.requiresInitialCommit ? (
                    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          checked={confirmedInitialCommit}
                          className="mt-0.5 size-4"
                          type="checkbox"
                          onChange={(event) =>
                            setConfirmedInitialCommit(event.target.checked)
                          }
                        />
                        <span>
                          Create an initial commit from the current folder
                          contents and push it to this empty repository.
                        </span>
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium">
                        Initial commit message
                        <Input
                          disabled={!confirmedInitialCommit}
                          maxLength={1_000}
                          value={commitMessage}
                          onChange={(event) =>
                            setCommitMessage(event.target.value)
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      checked={confirmedRepository}
                      className="mt-0.5 size-4"
                      type="checkbox"
                      onChange={(event) =>
                        setConfirmedRepository(event.target.checked)
                      }
                    />
                    <span>
                      Convert this project to{" "}
                      <strong>{preflight.repository.nameWithOwner}</strong>,
                      push without force, and enable Git/GitHub features only
                      after complete reconciliation.
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {(runPreflight.isError || start.isError || github.isError) && (
            <p className="text-sm text-destructive" role="alert">
              {errorText(runPreflight.error ?? start.error ?? github.error)}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={start.isPending}
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            {preflight?.status === "ready" ? (
              <Button
                disabled={
                  start.isPending ||
                  !commitMessage.trim() ||
                  !githubConversionCanStart({
                    confirmedInitialCommit,
                    confirmedRepository,
                    preflight,
                  })
                }
                type="button"
                onClick={() => start.mutate(preflight)}
              >
                {start.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FolderGit2 className="size-4" />
                )}
                Convert and push
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {workerId && github.data?.login ? (
        <GithubRepositoryCreateDialog
          initialize="empty"
          login={github.data.login}
          open={createRepositoryOpen}
          workerId={workerId}
          onOpenChange={setCreateRepositoryOpen}
          onCreated={async (repository) => {
            queryClient.setQueryData<GithubRepository[]>(
              ["github-repositories", workerId],
              (current = []) => [
                repository,
                ...current.filter(({ id }) => id !== repository.id),
              ],
            );
            setSelectedRepositoryId(repository.id);
            resetConfirmation();
          }}
        />
      ) : null}
    </section>
  );
}
