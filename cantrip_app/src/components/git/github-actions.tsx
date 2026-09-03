import type {
  GithubActionsJob,
  GithubActionsRun,
  GithubActionsRunAction,
  GithubActionsWorkflow,
} from "@cantrip/protocol";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CirclePlay,
  ExternalLink,
  FileArchive,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  TestTube2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContentEmpty, ContentLoading } from "@/components/ui/content-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import {
  dispatchGithubActionsWorkflow,
  getGithubActionsOverview,
  getGithubActionsRun,
  getGithubActionsRunLogs,
  runGithubActionsRunAction,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import { useNarrowViewport } from "@/lib/use-compact-layout";

import { GitContentSurface } from "./git-content-surface";
import {
  githubActionsFailedConclusions as failedConclusions,
  githubActionsRunAgentPrompt,
  githubActionsRunIsActive,
  githubActionsStatusLabel,
  type GithubActionsTarget,
  type GithubActionsViewStatus,
} from "./github-actions-model";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function statusTone(input: {
  conclusion: string | null;
  status: string;
}): string {
  if (input.status !== "completed") {
    return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
  if (input.conclusion === "success") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (failedConclusions.has(input.conclusion ?? "")) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted/50 text-muted-foreground";
}

function StatusIcon({
  conclusion,
  status,
}: {
  conclusion: string | null;
  status: string;
}) {
  if (status !== "completed") {
    return <Loader2 className="size-4 animate-spin text-blue-500" />;
  }
  if (conclusion === "success") {
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }
  if (failedConclusions.has(conclusion ?? "")) {
    return <XCircle className="size-4 text-destructive" />;
  }
  return <CircleDot className="size-4 text-muted-foreground" />;
}

function StatusBadge({
  value,
}: {
  value: { conclusion: string | null; status: string };
}) {
  return (
    <Badge variant="outline" className={cn("capitalize", statusTone(value))}>
      {githubActionsStatusLabel(value)}
    </Badge>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function WorkflowDispatchDialog({
  defaultRef,
  onDispatched,
  onOpenChange,
  open,
  projectId,
  selectedWorkflowId,
  workflows,
  worktreeId,
}: {
  defaultRef: string;
  onDispatched(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  selectedWorkflowId: number | null;
  workflows: GithubActionsWorkflow[];
  worktreeId: string;
}) {
  const [workflowId, setWorkflowId] = useState<number | null>(
    selectedWorkflowId,
  );
  const [ref, setRef] = useState(defaultRef);
  const [inputs, setInputs] = useState([{ key: "", value: "" }]);
  const dispatch = useMutation({
    mutationFn: () =>
      dispatchGithubActionsWorkflow(projectId, worktreeId, {
        workflowId: workflowId!,
        ref: ref.trim(),
        inputs: Object.fromEntries(
          inputs
            .map(({ key, value }) => [key.trim(), value] as const)
            .filter(([key]) => key),
        ),
      }),
    onSuccess: () => {
      onOpenChange(false);
      onDispatched();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Run a GitHub Actions workflow</DialogTitle>
          <DialogDescription>
            GitHub validates whether this workflow supports manual dispatch and
            whether its declared inputs are valid.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm">
            Workflow
            <NativeSelect
              value={workflowId ?? ""}
              onChange={(event) => setWorkflowId(Number(event.target.value))}
            >
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1.5 text-sm">
            Git ref
            <Input
              autoFocus
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder="main"
            />
          </label>
          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Workflow inputs</p>
                <p className="text-xs text-muted-foreground">
                  Add only inputs declared by the workflow.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setInputs((current) => [...current, { key: "", value: "" }])
                }
              >
                <Plus className="size-3.5" /> Input
              </Button>
            </div>
            {inputs.map((input, index) => (
              <div
                key={index}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              >
                <Input
                  aria-label={`Input ${index + 1} name`}
                  value={input.key}
                  onChange={(event) =>
                    setInputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, key: event.target.value }
                          : item,
                      ),
                    )
                  }
                  placeholder="name"
                />
                <Input
                  aria-label={`Input ${index + 1} value`}
                  value={input.value}
                  onChange={(event) =>
                    setInputs((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, value: event.target.value }
                          : item,
                      ),
                    )
                  }
                  placeholder="value"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={inputs.length === 1}
                  onClick={() =>
                    setInputs((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  <X className="size-4" />
                  <span className="sr-only">Remove input</span>
                </Button>
              </div>
            ))}
          </section>
          {dispatch.isError ? (
            <InlineAlert tone="error" error={dispatch.error} />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!workflowId || !ref.trim() || dispatch.isPending}
            onClick={() => dispatch.mutate()}
          >
            {dispatch.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Run workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunActionDialog({
  action,
  onOpenChange,
  onRun,
  open,
  pending,
  run,
}: {
  action: GithubActionsRunAction["action"] | null;
  onOpenChange(open: boolean): void;
  onRun(): void;
  open: boolean;
  pending: boolean;
  run: GithubActionsRun;
}) {
  const label =
    action === "cancel"
      ? "Cancel run"
      : action === "rerun-failed"
        ? "Rerun failed jobs"
        : "Rerun all jobs";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>
            {label} for workflow run #{run.runNumber}: {run.displayTitle}.
            GitHub remains authoritative for whether this action is currently
            allowed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep run
          </Button>
          <Button
            variant={action === "cancel" ? "destructive" : "default"}
            disabled={pending}
            onClick={onRun}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobsAndLogs({
  jobs,
  projectId,
  run,
  targetJobId,
  worktreeId,
}: {
  jobs: GithubActionsJob[];
  projectId: string;
  run: GithubActionsRun;
  targetJobId: number | null;
  worktreeId: string;
}) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(
    targetJobId,
  );
  const selectedJob =
    jobs.find(({ id }) => id === selectedJobId) ??
    jobs.find(({ conclusion }) => failedConclusions.has(conclusion ?? "")) ??
    jobs[0] ??
    null;
  const logs = useQuery({
    enabled: Boolean(selectedJob),
    queryKey: [
      "github-actions-run-logs",
      projectId,
      worktreeId,
      run.id,
      selectedJob?.id,
    ],
    queryFn: () =>
      getGithubActionsRunLogs(projectId, worktreeId, run.id, selectedJob!.id),
    refetchInterval: githubActionsRunIsActive(run) ? 5_000 : false,
    retry: false,
  });

  useEffect(() => {
    if (targetJobId && jobs.some(({ id }) => id === targetJobId)) {
      setSelectedJobId(targetJobId);
    }
  }, [jobs, targetJobId]);

  if (!selectedJob) {
    return (
      <ContentEmpty
        icon={<Activity className="size-5" />}
        title="No jobs yet"
        description="GitHub has not reported any jobs for this run."
      />
    );
  }
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="max-h-48 overflow-y-auto border-b md:max-h-none md:border-b-0 md:border-r">
        {jobs.map((job) => (
          <button
            key={job.id}
            type="button"
            onClick={() => setSelectedJobId(job.id)}
            className={cn(
              "flex min-h-12 w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs hover:bg-muted/50",
              selectedJob.id === job.id && "bg-muted",
            )}
          >
            <StatusIcon status={job.status} conclusion={job.conclusion} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{job.name}</span>
              <span className="block truncate text-[10px] capitalize text-muted-foreground">
                {githubActionsStatusLabel(job)}
              </span>
            </span>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{selectedJob.name}</p>
            <p className="truncate text-[10px] text-muted-foreground">
              {selectedJob.runnerName
                ? `${selectedJob.runnerName}${selectedJob.runnerGroupName ? ` · ${selectedJob.runnerGroupName}` : ""}`
                : "Runner is assigned when the job starts"}
            </p>
          </div>
          <Button size="sm" variant="ghost" asChild>
            <a href={selectedJob.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> Open job
            </a>
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(15rem,0.42fr)_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b p-3 lg:border-b-0 lg:border-r">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Steps
            </p>
            <div className="space-y-1">
              {selectedJob.steps.map((step) => (
                <div
                  key={`${step.number}:${step.name}`}
                  className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs odd:bg-muted/30"
                >
                  <StatusIcon
                    status={step.status}
                    conclusion={step.conclusion}
                  />
                  <span className="min-w-0 flex-1 truncate">{step.name}</span>
                  <span className="shrink-0 capitalize text-[10px] text-muted-foreground">
                    {githubActionsStatusLabel(step)}
                  </span>
                </div>
              ))}
              {selectedJob.steps.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Steps have not been reported yet.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex min-h-60 min-w-0 flex-col bg-black text-zinc-200">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-3 text-[10px] text-zinc-400">
              <span>Job log</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-zinc-400 hover:bg-white/10 hover:text-white"
                disabled={logs.isFetching}
                onClick={() => void logs.refetch()}
              >
                <RefreshCw
                  className={cn("size-3.5", logs.isFetching && "animate-spin")}
                />
                <span className="sr-only">Refresh job log</span>
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5">
              {logs.isLoading ? (
                <span className="text-zinc-500">Loading log…</span>
              ) : logs.isError ? (
                <span className="text-red-400">
                  {errorMessage(logs.error, "The log could not be loaded.")}
                </span>
              ) : !logs.data?.available ? (
                <span className="whitespace-pre-wrap text-zinc-500">
                  {logs.data?.text ||
                    "GitHub has not made this job log available yet. Steps continue to refresh while the run is active."}
                </span>
              ) : (
                <>
                  {logs.data.truncated ? (
                    <p className="mb-2 text-amber-300">
                      Earlier log output was truncated; showing the newest 1 MB.
                    </p>
                  ) : null}
                  <pre className="w-max min-w-full whitespace-pre-wrap break-words">
                    {logs.data.text || "This job did not produce log output."}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunDetail({
  onBack,
  onFixRun,
  projectId,
  summary,
  targetJobId,
  worktreeId,
}: {
  onBack(): void;
  onFixRun(run: GithubActionsRun, prompt: string): Promise<void> | void;
  projectId: string;
  summary: GithubActionsRun;
  targetJobId: number | null;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"jobs" | "artifacts">("jobs");
  const [pendingAction, setPendingAction] = useState<
    GithubActionsRunAction["action"] | null
  >(null);
  const detail = useQuery({
    queryKey: ["github-actions-run", projectId, worktreeId, summary.id],
    queryFn: () => getGithubActionsRun(projectId, worktreeId, summary.id),
    refetchInterval: (query) =>
      githubActionsRunIsActive(query.state.data?.run ?? summary)
        ? 5_000
        : false,
  });
  const run = detail.data?.run ?? summary;
  const action = useMutation({
    mutationFn: (value: GithubActionsRunAction["action"]) =>
      runGithubActionsRunAction(projectId, worktreeId, {
        runId: run.id,
        action: value,
      }),
    onSuccess: async () => {
      setPendingAction(null);
      await Promise.all([
        detail.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["github-actions-overview", projectId, worktreeId],
        }),
      ]);
    },
  });
  const fix = useMutation({
    mutationFn: async () =>
      await onFixRun(
        run,
        githubActionsRunAgentPrompt(run, detail.data?.jobs ?? []),
      ),
  });
  const canFix = failedConclusions.has(run.conclusion ?? "");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 md:hidden"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back to workflow runs</span>
        </Button>
        <StatusIcon status={run.status} conclusion={run.conclusion} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{run.displayTitle}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {run.name} · #{run.runNumber} · attempt {run.runAttempt}
          </p>
        </div>
        <StatusBadge value={run} />
        <Button size="sm" variant="ghost" asChild>
          <a href={run.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </Button>
        {run.status !== "completed" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPendingAction("cancel")}
          >
            <X className="size-3.5" /> Cancel
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPendingAction("rerun")}
            >
              <RotateCcw className="size-3.5" /> Rerun
            </Button>
            {run.conclusion !== "success" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPendingAction("rerun-failed")}
              >
                <RefreshCw className="size-3.5" /> Failed jobs
              </Button>
            ) : null}
          </>
        )}
        {canFix ? (
          <Button
            size="sm"
            disabled={fix.isPending}
            onClick={() => fix.mutate()}
          >
            {fix.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CirclePlay className="size-3.5" />
            )}
            Fix in agent worktree
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <GitBranch className="size-3" /> {run.headBranch ?? "detached"} @{" "}
          {run.headSha.slice(0, 8)}
        </span>
        <span>Triggered by @{run.actor}</span>
        <span>{dateFormatter.format(new Date(run.createdAt))}</span>
      </div>
      {detail.data?.warnings.map((warning) => (
        <InlineAlert key={warning} tone="warning" size="sm" className="m-2">
          {warning}
        </InlineAlert>
      ))}
      {action.isError || fix.isError ? (
        <InlineAlert
          tone="error"
          size="sm"
          className="m-2"
          error={action.error ?? fix.error}
        />
      ) : null}
      {detail.isLoading ? (
        <ContentLoading label="Loading jobs and artifacts…" />
      ) : detail.isError || !detail.data ? (
        <InlineAlert className="m-4" tone="error" error={detail.error} />
      ) : (
        <>
          <NavigationTabBar<"jobs" | "artifacts">
            activeTab={tab}
            ariaLabel="Workflow run details"
            className="h-10 border-b px-3"
            tabs={[
              { id: "jobs", label: `Jobs (${detail.data.jobs.length})` },
              {
                id: "artifacts",
                label: `Artifacts (${detail.data.artifacts.length})`,
              },
            ]}
            onTabChange={setTab}
          />
          {tab === "jobs" ? (
            <JobsAndLogs
              jobs={detail.data.jobs}
              projectId={projectId}
              run={run}
              targetJobId={targetJobId}
              worktreeId={worktreeId}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {detail.data.artifacts.length ? (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {detail.data.artifacts.map((artifact) => (
                    <a
                      key={artifact.id}
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-24 items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/50"
                    >
                      {artifact.testReport ? (
                        <TestTube2 className="mt-0.5 size-4 text-blue-500" />
                      ) : (
                        <FileArchive className="mt-0.5 size-4 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {artifact.name}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {formatBytes(artifact.sizeInBytes)} · expires{" "}
                          {dateFormatter.format(new Date(artifact.expiresAt))}
                        </span>
                        <span className="mt-2 flex items-center gap-2">
                          {artifact.testReport ? (
                            <Badge variant="secondary">Test report</Badge>
                          ) : null}
                          {artifact.expired ? (
                            <Badge variant="outline">Expired</Badge>
                          ) : null}
                        </span>
                      </span>
                      <ExternalLink className="size-3.5 text-muted-foreground" />
                    </a>
                  ))}
                </div>
              ) : (
                <ContentEmpty
                  icon={<FileArchive className="size-5" />}
                  title="No artifacts"
                  description="This run did not publish artifacts or test reports."
                />
              )}
            </div>
          )}
        </>
      )}
      <RunActionDialog
        action={pendingAction}
        open={pendingAction !== null}
        pending={action.isPending}
        run={run}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setPendingAction(null);
        }}
        onRun={() => {
          if (pendingAction) action.mutate(pendingAction);
        }}
      />
    </div>
  );
}

export function GithubActionsView({
  defaultRef,
  onFixRun,
  onStatusChange,
  projectId,
  refreshEpoch,
  target,
  worktreeId,
}: {
  defaultRef: string;
  onFixRun(run: GithubActionsRun, prompt: string): Promise<void> | void;
  onStatusChange(status: GithubActionsViewStatus | null): void;
  projectId: string;
  refreshEpoch: number;
  target: GithubActionsTarget | null;
  worktreeId: string;
}) {
  const narrowViewport = useNarrowViewport();
  const queryClient = useQueryClient();
  const [workflowFilter, setWorkflowFilter] = useState<number | "all">("all");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(
    target?.runId ?? null,
  );
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchWorkflowId, setDispatchWorkflowId] = useState<number | null>(
    null,
  );
  const overview = useInfiniteQuery({
    initialPageParam: 1,
    queryKey: ["github-actions-overview", projectId, worktreeId, refreshEpoch],
    queryFn: ({ pageParam }) =>
      getGithubActionsOverview(projectId, worktreeId, pageParam),
    getNextPageParam: (page) => page.nextPage ?? undefined,
    refetchInterval: (query) => {
      const runs = query.state.data?.pages.flatMap((page) => page.runs) ?? [];
      return runs.some(githubActionsRunIsActive) ? 5_000 : 30_000;
    },
  });
  const firstPage = overview.data?.pages[0];
  const workflows = firstPage?.workflows ?? [];
  const runs = useMemo(
    () => overview.data?.pages.flatMap((page) => page.runs) ?? [],
    [overview.data],
  );
  const filteredRuns =
    workflowFilter === "all"
      ? runs
      : runs.filter(({ workflowId }) => workflowId === workflowFilter);
  const listedSelectedRun = runs.find(({ id }) => id === selectedRunId) ?? null;
  const linkedRun = useQuery({
    enabled: selectedRunId !== null && listedSelectedRun === null,
    queryKey: ["github-actions-run", projectId, worktreeId, selectedRunId],
    queryFn: () => getGithubActionsRun(projectId, worktreeId, selectedRunId!),
  });
  const selectedRun = listedSelectedRun ?? linkedRun.data?.run ?? null;
  const dispatchRefresh = () =>
    void queryClient.invalidateQueries({
      queryKey: ["github-actions-overview", projectId, worktreeId],
    });

  useEffect(() => {
    if (target?.runId) setSelectedRunId(target.runId);
  }, [target?.runId]);

  useEffect(() => {
    if (!narrowViewport && selectedRunId === null && filteredRuns[0]) {
      setSelectedRunId(filteredRuns[0].id);
    }
  }, [filteredRuns, narrowViewport, selectedRunId]);

  useEffect(() => {
    onStatusChange({
      activeRunCount: runs.filter(githubActionsRunIsActive).length,
      isFetching: overview.isFetching,
      runCount: firstPage?.totalRunCount ?? runs.length,
    });
    return () => onStatusChange(null);
  }, [firstPage?.totalRunCount, onStatusChange, overview.isFetching, runs]);

  return (
    <GitContentSurface
      className="flex min-h-0 flex-1 flex-col"
      dataSlot="github-actions-content"
      guttered
    >
      {firstPage ? (
        <div className="shrink-0 border-b px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Self-hosted runners</span>
            {firstPage.runnerAccess === "unavailable" ? (
              <Badge variant="outline">Permission unavailable</Badge>
            ) : firstPage.runners.length ? (
              firstPage.runners.map((runner) => (
                <Badge
                  key={runner.id}
                  variant="outline"
                  className={cn(
                    runner.status === "online" && !runner.busy
                      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                      : runner.status === "online"
                        ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                        : "text-muted-foreground",
                  )}
                  title={runner.labels.join(", ")}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      runner.status === "online"
                        ? runner.busy
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                        : "bg-muted-foreground",
                    )}
                  />
                  {runner.name} · {runner.busy ? "busy" : runner.status}
                </Badge>
              ))
            ) : (
              <span className="text-[10px] text-muted-foreground">
                None registered. GitHub-hosted runners appear on jobs after
                assignment.
              </span>
            )}
          </div>
          {firstPage.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-[10px] text-amber-600">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className={cn(
            "min-h-0 w-full shrink-0 overflow-y-auto border-r md:w-[23rem]",
            narrowViewport && selectedRun && "hidden",
          )}
        >
          <section className="border-b p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium">Workflows</p>
                <p className="text-[10px] text-muted-foreground">
                  Repository GitHub Actions
                </p>
              </div>
              <Button
                size="sm"
                disabled={!workflows.length}
                onClick={() => {
                  setDispatchWorkflowId(null);
                  setDispatchOpen(true);
                }}
              >
                <Play className="size-3.5" /> Run
              </Button>
            </div>
            {workflows.length ? (
              <div className="space-y-1">
                {workflows.slice(0, 6).map((workflow) => (
                  <div
                    key={workflow.id}
                    className="flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-muted/50"
                  >
                    <Activity className="size-3.5 text-muted-foreground" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-xs"
                      title={workflow.path}
                      onClick={() => setWorkflowFilter(workflow.id)}
                    >
                      {workflow.name}
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      title={`Run ${workflow.name}`}
                      onClick={() => {
                        setDispatchWorkflowId(workflow.id);
                        setDispatchOpen(true);
                      }}
                    >
                      <Play className="size-3" />
                    </button>
                  </div>
                ))}
                {workflows.length > 6 ? (
                  <p className="px-2 text-[10px] text-muted-foreground">
                    +{workflows.length - 6} more workflows in the filter
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="py-3 text-xs text-muted-foreground">
                No workflows found in this repository.
              </p>
            )}
          </section>
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 p-2 backdrop-blur">
            <NativeSelect
              size="sm"
              className="min-w-0 flex-1"
              value={workflowFilter}
              onChange={(event) =>
                setWorkflowFilter(
                  event.target.value === "all"
                    ? "all"
                    : Number(event.target.value),
                )
              }
            >
              <option value="all">All workflow runs</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </NativeSelect>
            <span className="text-[10px] text-muted-foreground">
              {firstPage?.totalRunCount ?? runs.length}
            </span>
          </div>
          {overview.isLoading ? (
            <ContentLoading label="Loading GitHub Actions…" />
          ) : overview.isError ? (
            <InlineAlert className="m-3" tone="error" error={overview.error} />
          ) : filteredRuns.length ? (
            <>
              {filteredRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  data-high-contrast-row
                  className={cn(
                    "grid min-h-20 w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 border-b border-border/50 px-3 py-2 text-left hover:bg-muted/50",
                    selectedRun?.id === run.id && "bg-muted",
                  )}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <StatusIcon status={run.status} conclusion={run.conclusion} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {run.displayTitle}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {run.name} · #{run.runNumber}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                  <span className="col-start-2 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">
                      {run.headBranch ?? run.headSha.slice(0, 8)}
                    </span>
                    <span className="capitalize">
                      {githubActionsStatusLabel(run)}
                    </span>
                    <span className="ml-auto shrink-0">
                      {dateFormatter.format(new Date(run.updatedAt))}
                    </span>
                  </span>
                </button>
              ))}
              {overview.hasNextPage ? (
                <div className="p-3 text-center">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={overview.isFetchingNextPage}
                    onClick={() => void overview.fetchNextPage()}
                  >
                    {overview.isFetchingNextPage ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    Load older runs
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <ContentEmpty
              icon={<CirclePlay className="size-5" />}
              title="No workflow runs"
              description="Run a workflow manually or push a change that triggers one."
            />
          )}
        </aside>
        {selectedRun ? (
          <RunDetail
            key={`${selectedRun.id}:${target?.jobId ?? "all"}`}
            projectId={projectId}
            summary={selectedRun}
            targetJobId={target?.runId === selectedRun.id ? target.jobId : null}
            worktreeId={worktreeId}
            onBack={() => setSelectedRunId(null)}
            onFixRun={onFixRun}
          />
        ) : linkedRun.isLoading ? (
          <ContentLoading label="Opening workflow run…" />
        ) : linkedRun.isError ? (
          <InlineAlert className="m-4" tone="error" error={linkedRun.error} />
        ) : !narrowViewport ? (
          <ContentEmpty
            className="min-w-0 flex-1"
            icon={<CirclePlay className="size-5" />}
            title="Select a workflow run"
            description="Inspect its jobs, live status, logs, artifacts, and test reports."
          />
        ) : null}
      </div>
      <WorkflowDispatchDialog
        key={`${dispatchOpen}:${dispatchWorkflowId ?? "all"}`}
        defaultRef={defaultRef || "main"}
        open={dispatchOpen}
        projectId={projectId}
        selectedWorkflowId={dispatchWorkflowId}
        workflows={workflows}
        worktreeId={worktreeId}
        onDispatched={dispatchRefresh}
        onOpenChange={setDispatchOpen}
      />
    </GitContentSurface>
  );
}
