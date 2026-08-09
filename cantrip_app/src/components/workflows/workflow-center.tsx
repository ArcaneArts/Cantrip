import type { ChatSummary } from "@cantrip/protocol";
import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowGraph,
  WorkflowJsonObject,
  WorkflowNodeAttempt,
  WorkflowPermissionRequirements,
  WorkflowRunDetail,
  WorkflowRunNode,
  WorkflowRunStatus,
  WorkflowWorktreeOutcomeAction,
} from "@cantrip/protocol/workflows";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  BookmarkPlus,
  CircleAlert,
  CirclePause,
  CirclePlay,
  Clock3,
  GitBranch,
  Loader2,
  Network,
  OctagonX,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelWorkflowRun,
  createWorkflowRun,
  decideWorkflowGate,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRuns,
  getWorkflows,
  pauseWorkflowRun,
  resolveWorkflowWorktree,
  resumeWorkflowRun,
  retryWorkflowNode,
  saveWorkflowRunRevision,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { WorkflowAuthorDialog } from "./workflow-author-dialog";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const activeRunStatuses = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "waiting",
  "paused",
  "cancelling",
  "recovering",
]);

export function parseWorkflowInput(value: string): WorkflowJsonObject {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Workflow input must be a JSON object.");
  }
  return parsed as WorkflowJsonObject;
}

export function workflowDuration(
  startedAt: string | null,
  completedAt: string | null,
  now = Date.now(),
) {
  if (!startedAt) return "Not started";
  const duration = Math.max(
    0,
    (completedAt ? new Date(completedAt).getTime() : now) -
      new Date(startedAt).getTime(),
  );
  if (duration < 60_000) return `${Math.round(duration / 1_000)}s`;
  if (duration < 3_600_000) return `${Math.round(duration / 60_000)}m`;
  return `${(duration / 3_600_000).toFixed(1)}h`;
}

export function workflowRunActions(status: WorkflowRunStatus) {
  return {
    canCancel: [
      "queued",
      "running",
      "waiting",
      "paused",
      "recovering",
    ].includes(status),
    canPause: ["queued", "running", "waiting"].includes(status),
    canResume: status === "paused",
  };
}

function identifier(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The workflow request failed.";
}

function statusClass(status: string) {
  if (["completed", "approved", "kept", "delivered"].includes(status)) {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (["failed", "cancelled", "denied", "blocked"].includes(status)) {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (["running", "queued", "retrying", "recovering"].includes(status)) {
    return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
  if (
    ["waiting", "waiting-for-approval", "paused", "checkpointed"].includes(
      status,
    )
  ) {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted/50 text-muted-foreground";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("capitalize", statusClass(status))}>
      {status.replaceAll("-", " ")}
    </Badge>
  );
}

function PermissionSummary({
  permissions,
}: {
  permissions: WorkflowPermissionRequirements;
}) {
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-3">
      <div className="rounded-lg border p-2.5">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Filesystem
        </span>
        <strong className="mt-1 block font-medium capitalize">
          {permissions.filesystem.replaceAll("-", " ")}
        </strong>
      </div>
      <div className="rounded-lg border p-2.5">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Network className="size-3.5" /> Network
        </span>
        <strong className="mt-1 block font-medium capitalize">
          {permissions.network}
        </strong>
      </div>
      <div className="rounded-lg border p-2.5">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CirclePause className="size-3.5" /> Approval
        </span>
        <strong className="mt-1 block font-medium capitalize">
          {permissions.approvalMode}
        </strong>
      </div>
    </div>
  );
}

function definitionLabel(workflow: WorkflowDefinitionSummary) {
  return `${workflow.scope === "personal" ? "personal" : "project"}/${workflow.slug}`;
}

function workflowNodePrompt(node: WorkflowGraph["nodes"][number] | undefined) {
  if (!node || !("prompt" in node.configuration)) return null;
  return typeof node.configuration.prompt === "string"
    ? node.configuration.prompt
    : null;
}

type ControlAction =
  | { type: "cancel"; runId: string }
  | { type: "deny" | "approve"; runId: string; gateId: string }
  | {
      type: "outcome";
      runId: string;
      leaseId: string;
      action: WorkflowWorktreeOutcomeAction;
      endingRevision: string;
    }
  | { type: "pause" | "resume"; runId: string }
  | { type: "retry"; runId: string; nodeId: string };

export function WorkflowCenter({
  chats,
  initialWorkflowId,
  onOpenHistory,
  projectId,
}: {
  chats: ChatSummary[];
  initialWorkflowId?: string | null;
  onOpenHistory(worktreeId: string): void;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    initialWorkflowId ?? null,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [authorWorkflow, setAuthorWorkflow] =
    useState<WorkflowDefinitionDetail | null>(null);
  const [launchStep, setLaunchStep] = useState<"input" | "review">("input");
  const [inputText, setInputText] = useState("{}");
  const [inputError, setInputError] = useState<string | null>(null);
  const [preparedInput, setPreparedInput] = useState<WorkflowJsonObject>({});

  const workflows = useQuery({
    queryFn: () => getWorkflows({ limit: 500 }),
    queryKey: ["workflows"],
  });
  const visibleWorkflows = useMemo(
    () =>
      (workflows.data ?? []).filter(
        (workflow) =>
          workflow.scope === "personal" || workflow.projectId === projectId,
      ),
    [projectId, workflows.data],
  );

  useEffect(() => {
    if (workflows.isPending) return;
    if (
      !selectedWorkflowId ||
      !visibleWorkflows.some(({ id }) => id === selectedWorkflowId)
    ) {
      setSelectedWorkflowId(visibleWorkflows[0]?.id ?? null);
    }
  }, [selectedWorkflowId, visibleWorkflows, workflows.isPending]);

  const workflow = useQuery({
    enabled: Boolean(selectedWorkflowId),
    queryFn: () => getWorkflow(selectedWorkflowId!),
    queryKey: ["workflow", selectedWorkflowId],
  });
  const runs = useQuery({
    queryFn: () => getWorkflowRuns({ limit: 100, projectId }),
    queryKey: ["workflow-runs", projectId],
    refetchInterval: (query) =>
      query.state.data?.some(({ status }) => activeRunStatuses.has(status))
        ? 2_000
        : false,
  });

  useEffect(() => {
    if (!selectedRunId || !runs.data?.some(({ id }) => id === selectedRunId)) {
      setSelectedRunId(runs.data?.[0]?.id ?? null);
    }
  }, [runs.data, selectedRunId]);

  const run = useQuery({
    enabled: Boolean(selectedRunId),
    queryFn: () => getWorkflowRun(selectedRunId!),
    queryKey: ["workflow-run", selectedRunId],
    refetchInterval: (query) =>
      query.state.data && activeRunStatuses.has(query.state.data.run.status)
        ? 1_500
        : false,
  });

  const storeRun = (detail: WorkflowRunDetail) => {
    queryClient.setQueryData(["workflow-run", detail.run.id], detail);
    void queryClient.invalidateQueries({
      queryKey: ["workflow-runs", projectId],
    });
  };

  const launch = useMutation({
    mutationFn: async () => {
      const revision = workflow.data?.revision;
      if (!revision) throw new Error("This workflow has no runnable revision.");
      return createWorkflowRun({
        workflowRevisionId: revision.id,
        projectId,
        structuredInput: preparedInput,
        budget: {
          maxNodes: 100,
          maxAttemptsPerNode: 3,
          maxParallelism: 4,
          maxTokens: null,
          maxDurationMs: 3_600_000,
          maxNodeDurationMs: 900_000,
          maxEstimatedCostUsd: null,
        },
        permissionManifest: revision.permissionRequirements,
        selectedModelRouteId: null,
        selectedPermissionProfileId: null,
        trigger: {
          type: "manual",
          sourceId: null,
          actorType: "user",
          actorId: null,
          deliveredAt: new Date().toISOString(),
          metadata: {},
        },
        idempotencyKey: identifier("workflow-run"),
      });
    },
    onSuccess: (detail) => {
      storeRun(detail);
      setSelectedRunId(detail.run.id);
      setLaunchOpen(false);
      setLaunchStep("input");
    },
  });

  const control = useMutation({
    mutationFn: (action: ControlAction) => {
      const idempotencyKey = identifier(`workflow-${action.type}`);
      switch (action.type) {
        case "pause":
          return pauseWorkflowRun(action.runId, {
            reason: "Paused from the workflow center.",
            idempotencyKey,
          });
        case "resume":
          return resumeWorkflowRun(action.runId, {
            reason: "Resumed from the workflow center.",
            idempotencyKey,
          });
        case "cancel":
          return cancelWorkflowRun(action.runId, {
            reason: "Cancelled from the workflow center.",
            idempotencyKey,
          });
        case "retry":
          return retryWorkflowNode(action.runId, action.nodeId, {
            reason: "Retried from the workflow center.",
            idempotencyKey,
          });
        case "approve":
        case "deny":
          return decideWorkflowGate(action.runId, action.gateId, {
            decision: action.type === "approve" ? "approved" : "denied",
            reason: null,
            idempotencyKey,
          });
        case "outcome":
          return resolveWorkflowWorktree(action.runId, action.leaseId, {
            action: action.action,
            expectedEndingRevision: action.endingRevision,
            idempotencyKey,
          });
      }
    },
    onSuccess: storeRun,
  });
  const saveRun = useMutation({
    mutationFn: (runId: string) =>
      saveWorkflowRunRevision(runId, {
        trustState: "modified",
        useRunInputAsDefaults: true,
      }),
    onSuccess: (saved) => {
      setSelectedWorkflowId(saved.workflow.id);
      queryClient.setQueryData(["workflow", saved.workflow.id], saved);
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });

  const selectedDefinition = visibleWorkflows.find(
    ({ id }) => id === selectedWorkflowId,
  );
  const controlError = control.error ?? launch.error ?? saveRun.error;

  const prepareReview = () => {
    try {
      setPreparedInput(parseWorkflowInput(inputText));
      setInputError(null);
      setLaunchStep("review");
    } catch (error) {
      setInputError(errorText(error));
    }
  };

  return (
    <section aria-labelledby="workflows-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="workflows-title" className="font-semibold">
            Workflows
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch and supervise personal or project automation on isolated
            Cantrip execution lanes.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={workflows.isFetching || runs.isFetching}
            onClick={() => {
              void workflows.refetch();
              void runs.refetch();
              if (selectedRunId) void run.refetch();
            }}
          >
            <RefreshCw
              className={cn(
                "size-4",
                (workflows.isFetching || runs.isFetching) && "animate-spin",
              )}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAuthorWorkflow(null);
              setAuthorOpen(true);
            }}
          >
            <Plus className="size-4" /> New workflow
          </Button>
        </div>
      </div>

      {workflows.isError ||
      workflow.isError ||
      runs.isError ||
      run.isError ||
      controlError ? (
        <div className="flex gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {errorText(
              workflows.error ??
                workflow.error ??
                runs.error ??
                run.error ??
                controlError,
            )}
          </span>
        </div>
      ) : null}

      <div className="grid min-h-[24rem] overflow-hidden rounded-xl border lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="border-b bg-muted/20 lg:border-b-0 lg:border-r">
          <div className="border-b px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Available ({visibleWorkflows.length})
          </div>
          <div className="max-h-[34rem] overflow-y-auto p-2">
            {visibleWorkflows.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "mb-1 w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted",
                  item.id === selectedWorkflowId && "bg-muted",
                )}
                onClick={() => setSelectedWorkflowId(item.id)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {item.name}
                  </span>
                  <StatusBadge status={item.trustState} />
                </span>
                <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                  {definitionLabel(item)}
                </span>
              </button>
            ))}
            {!visibleWorkflows.length ? (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                {workflows.isPending
                  ? "Loading workflows…"
                  : "No workflows yet."}
              </div>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 p-4 sm:p-5">
          {workflow.isPending && selectedWorkflowId ? (
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : workflow.data && selectedDefinition ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">
                      {workflow.data.workflow.name}
                    </h3>
                    <StatusBadge status={workflow.data.workflow.trustState} />
                    <Badge variant="secondary" className="capitalize">
                      {workflow.data.workflow.scope}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {workflow.data.workflow.description ??
                      "No description provided."}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {definitionLabel(workflow.data.workflow)} ·{" "}
                    {workflow.data.workflow.source}
                    {workflow.data.revision
                      ? ` · revision ${workflow.data.revision.revision} · ${workflow.data.revision.contentHash.slice(0, 20)}…`
                      : " · no revision"}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAuthorWorkflow(workflow.data);
                      setAuthorOpen(true);
                    }}
                  >
                    <Pencil className="size-4" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      !workflow.data.revision ||
                      workflow.data.workflow.trustState === "blocked"
                    }
                    onClick={() => {
                      setInputText(
                        JSON.stringify(
                          workflow.data?.revision?.defaults ?? {},
                          null,
                          2,
                        ),
                      );
                      setInputError(null);
                      setLaunchStep("input");
                      setLaunchOpen(true);
                    }}
                  >
                    <Play className="size-4" /> Run
                  </Button>
                </div>
              </div>

              {workflow.data.revision ? (
                <>
                  <PermissionSummary
                    permissions={workflow.data.revision.permissionRequirements}
                  />
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-sm font-medium">Planned stages</h4>
                      <span className="text-xs text-muted-foreground">
                        {workflow.data.revision.nodes.length} nodes ·{" "}
                        {workflow.data.revision.edges.length} dependencies
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {workflow.data.revision.nodes.map((node, index) => (
                        <div key={node.key} className="rounded-lg border p-3">
                          <span className="flex items-center gap-2">
                            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-medium">
                              {index + 1}
                            </span>
                            <strong className="truncate text-sm font-medium">
                              {node.name}
                            </strong>
                          </span>
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            <Badge variant="outline" className="capitalize">
                              {node.type}
                            </Badge>
                            <Badge variant="outline" className="capitalize">
                              {node.mutationMode.replaceAll("-", " ")}
                            </Badge>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
              Select a workflow to inspect its latest revision.
            </div>
          )}
        </div>
      </div>

      <div className="grid min-h-[28rem] overflow-hidden rounded-xl border xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="border-b bg-muted/20 xl:border-b-0 xl:border-r">
          <div className="border-b px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Project runs ({runs.data?.length ?? 0})
          </div>
          <div className="max-h-[42rem] overflow-y-auto p-2">
            {(runs.data ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "mb-1 w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted",
                  item.id === selectedRunId && "bg-muted",
                )}
                onClick={() => {
                  setSelectedRunId(item.id);
                  setSelectedWorkflowId(item.workflowId);
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">
                    {item.id.slice(0, 8)}
                  </span>
                  <StatusBadge status={item.status} />
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{dateTime.format(new Date(item.createdAt))}</span>
                  <span>
                    {workflowDuration(item.startedAt, item.completedAt)}
                  </span>
                </span>
              </button>
            ))}
            {!runs.data?.length ? (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                {runs.isPending ? "Loading runs…" : "No runs in this project."}
              </div>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 p-4 sm:p-5">
          {run.isPending && selectedRunId ? (
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : run.data ? (
            <RunDetail
              detail={run.data}
              pending={control.isPending || saveRun.isPending}
              revisionNodes={workflow.data?.revision?.nodes ?? []}
              onControl={(action) => control.mutate(action)}
              onOpenHistory={onOpenHistory}
              onSaveRevision={() => saveRun.mutate(run.data!.run.id)}
            />
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
              Select a run to inspect its progress and recovery state.
            </div>
          )}
        </div>
      </div>

      <Dialog open={launchOpen} onOpenChange={setLaunchOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {launchStep === "input"
                ? "Workflow input"
                : "Review workflow run"}
            </DialogTitle>
            <DialogDescription>
              {launchStep === "input"
                ? "Provide a structured JSON object. Defaults from the selected revision are prefilled."
                : "Confirm the stages, permission envelope, and execution budget before launch."}
            </DialogDescription>
          </DialogHeader>
          {launchStep === "input" ? (
            <div>
              <label htmlFor="workflow-input" className="text-sm font-medium">
                Structured arguments
              </label>
              <textarea
                id="workflow-input"
                className="mt-2 min-h-56 w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                spellCheck={false}
              />
              {inputError ? (
                <p className="mt-2 text-sm text-destructive">{inputError}</p>
              ) : null}
              {workflow.data?.revision ? (
                <details className="mt-3 rounded-lg border p-3 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Declared input schema
                  </summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                    {JSON.stringify(
                      workflow.data.revision.declaredInputs,
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : workflow.data?.revision ? (
            <div className="space-y-4">
              <PermissionSummary
                permissions={workflow.data.revision.permissionRequirements}
              />
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Stages</span>
                  <strong className="mt-1 block text-sm">
                    {workflow.data.revision.nodes.length}
                  </strong>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Parallelism</span>
                  <strong className="mt-1 block text-sm">Up to 4</strong>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Time limit</span>
                  <strong className="mt-1 block text-sm">1 hour</strong>
                </div>
              </div>
              <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(preparedInput, null, 2)}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                launchStep === "review"
                  ? setLaunchStep("input")
                  : setLaunchOpen(false)
              }
            >
              {launchStep === "review" ? "Back" : "Cancel"}
            </Button>
            {launchStep === "input" ? (
              <Button onClick={prepareReview}>Review</Button>
            ) : (
              <Button
                disabled={launch.isPending}
                onClick={() => launch.mutate()}
              >
                {launch.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Launch
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkflowAuthorDialog
        chats={chats}
        open={authorOpen}
        projectId={projectId}
        workflow={authorWorkflow}
        onOpenChange={setAuthorOpen}
        onSaved={(saved) => {
          setSelectedWorkflowId(saved.workflow.id);
          setAuthorWorkflow(saved);
          queryClient.setQueryData(["workflow", saved.workflow.id], saved);
          void queryClient.invalidateQueries({ queryKey: ["workflows"] });
        }}
      />
    </section>
  );
}

function RunDetail({
  detail,
  onControl,
  onOpenHistory,
  onSaveRevision,
  pending,
  revisionNodes,
}: {
  detail: WorkflowRunDetail;
  onControl(action: ControlAction): void;
  onOpenHistory(worktreeId: string): void;
  onSaveRevision(): void;
  pending: boolean;
  revisionNodes: WorkflowGraph["nodes"];
}) {
  const { run } = detail;
  const actions = workflowRunActions(run.status);
  const completed = detail.nodes.filter(
    ({ status }) => status === "completed",
  ).length;
  const failed = detail.nodes.filter(
    ({ status }) => status === "failed",
  ).length;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">Run {run.id.slice(0, 8)}</h3>
            <StatusBadge status={run.status} />
            <StatusBadge status={run.recoveryState} />
          </span>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3.5" />{" "}
              {workflowDuration(run.startedAt, run.completedAt)}
            </span>
            <span>
              {completed}/{detail.nodes.length} nodes complete
            </span>
            {failed ? (
              <span className="text-destructive">{failed} failed</span>
            ) : null}
            <span>{run.measuredUsage.totalTokens} tokens</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {run.status === "completed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={onSaveRevision}
            >
              <BookmarkPlus className="size-4" /> Save as revision
            </Button>
          ) : null}
          {actions.canPause ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onControl({ type: "pause", runId: run.id })}
            >
              <CirclePause className="size-4" /> Pause
            </Button>
          ) : null}
          {actions.canResume ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onControl({ type: "resume", runId: run.id })}
            >
              <CirclePlay className="size-4" /> Resume
            </Button>
          ) : null}
          {actions.canCancel ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onControl({ type: "cancel", runId: run.id })}
            >
              <OctagonX className="size-4" /> Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {run.errorMessage || run.pauseReason ? (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            run.errorMessage
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-amber-500/40 bg-amber-500/10",
          )}
        >
          {run.errorMessage ?? run.pauseReason}
        </div>
      ) : null}

      <PermissionSummary permissions={run.permissionManifest} />

      {detail.gates.some(({ status }) => status === "pending") ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Waiting for approval</h4>
          {detail.gates
            .filter(({ status }) => status === "pending")
            .map((gate) => (
              <div
                key={gate.id}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
              >
                <p className="text-sm leading-6">{gate.prompt}</p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      onControl({
                        type: "approve",
                        runId: run.id,
                        gateId: gate.id,
                      })
                    }
                  >
                    <Check className="size-4" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      onControl({
                        type: "deny",
                        runId: run.id,
                        gateId: gate.id,
                      })
                    }
                  >
                    <X className="size-4" /> Deny
                  </Button>
                </div>
              </div>
            ))}
        </div>
      ) : null}

      <div>
        <h4 className="mb-2 text-sm font-medium">Run graph</h4>
        <div className="space-y-2">
          {detail.nodes.map((node) => (
            <RunNode
              attempts={detail.attempts.filter(
                ({ runNodeId }) => runNodeId === node.id,
              )}
              key={node.id}
              node={node}
              pending={pending}
              runId={run.id}
              onRetry={() =>
                onControl({ type: "retry", runId: run.id, nodeId: node.id })
              }
              onOpenHistory={onOpenHistory}
              prompt={workflowNodePrompt(
                revisionNodes.find(({ key }) => key === node.nodeKey),
              )}
            />
          ))}
        </div>
      </div>

      {detail.worktreeLeases.length ? (
        <div>
          <h4 className="mb-2 text-sm font-medium">Execution lanes</h4>
          <div className="space-y-2">
            {detail.worktreeLeases.map((lease) => (
              <div key={lease.id} className="rounded-lg border p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranch className="size-4 shrink-0" />
                    <code className="truncate">
                      {lease.branchName ?? lease.worktreeId ?? "Allocating"}
                    </code>
                  </span>
                  <StatusBadge status={lease.outcome ?? lease.state} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">
                  {lease.startingRevision ? (
                    <code>from {lease.startingRevision.slice(0, 8)}</code>
                  ) : null}
                  {lease.endingRevision ? (
                    <code>to {lease.endingRevision.slice(0, 8)}</code>
                  ) : null}
                  {lease.worktreeDirty !== null ? (
                    <span>{lease.worktreeDirty ? "dirty" : "clean"}</span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {lease.worktreeId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenHistory(lease.worktreeId!)}
                    >
                      <GitBranch className="size-4" /> Open Git
                    </Button>
                  ) : null}
                  {lease.state === "checkpointed" && lease.endingRevision
                    ? (["keep", "deliver", "discard", "release"] as const).map(
                        (action) => (
                          <Button
                            key={action}
                            size="sm"
                            variant="outline"
                            className="capitalize"
                            disabled={pending}
                            onClick={() =>
                              onControl({
                                type: "outcome",
                                runId: run.id,
                                leaseId: lease.id,
                                action,
                                endingRevision: lease.endingRevision!,
                              })
                            }
                          >
                            {action}
                          </Button>
                        ),
                      )
                    : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunNode({
  attempts,
  node,
  onOpenHistory,
  onRetry,
  pending,
  prompt,
  runId,
}: {
  attempts: WorkflowNodeAttempt[];
  node: WorkflowRunNode;
  onOpenHistory(worktreeId: string): void;
  onRetry(): void;
  pending: boolean;
  prompt: string | null;
  runId: string;
}) {
  const retryable =
    node.status === "failed" && !["condition", "gate"].includes(node.nodeType);
  const latestAttempt = attempts.at(-1);
  return (
    <details
      className="rounded-lg border"
      open={
        node.status === "running" ||
        node.status === "failed" ||
        node.status === "waiting-for-approval"
      }
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          {node.status === "running" ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-blue-500" />
          ) : (
            <Workflow className="size-4 shrink-0 text-muted-foreground" />
          )}
          <strong className="truncate text-sm font-medium">
            {node.nodeKey}
          </strong>
          <Badge variant="outline" className="capitalize">
            {node.nodeType}
          </Badge>
        </span>
        <StatusBadge status={node.status} />
      </summary>
      <div className="border-t px-3 py-3 text-xs">
        <div className="grid gap-2 text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
          <span>
            Duration{" "}
            <strong className="block font-medium text-foreground">
              {workflowDuration(node.startedAt, node.completedAt)}
            </strong>
          </span>
          <span>
            Usage{" "}
            <strong className="block font-medium text-foreground">
              {node.measuredUsage.totalTokens} tokens
            </strong>
          </span>
          <span>
            Model{" "}
            <strong className="block truncate font-mono font-medium text-foreground">
              {node.modelRouteId ?? "Pending"}
            </strong>
          </span>
          <span>
            Worker{" "}
            <strong className="block truncate font-mono font-medium text-foreground">
              {node.workerId ?? "Pending"}
            </strong>
          </span>
          <span>
            Worktree{" "}
            <strong className="block truncate font-mono font-medium text-foreground">
              {node.worktreeId ?? "Read-only/shared"}
            </strong>
          </span>
          <span>
            Codex thread{" "}
            <strong className="block truncate font-mono font-medium text-foreground">
              {node.codexThreadId ?? "Not started"}
            </strong>
          </span>
          <span>
            Attempts{" "}
            <strong className="block font-medium text-foreground">
              {node.attemptCount}
            </strong>
          </span>
          <span>
            Run node{" "}
            <strong className="block truncate font-mono font-medium text-foreground">
              {node.id.slice(0, 8)}
            </strong>
          </span>
        </div>
        {prompt ? (
          <div className="mt-3 rounded-lg bg-muted/60 p-3">
            <span className="font-medium text-foreground">Prompt</span>
            <p className="mt-1 whitespace-pre-wrap leading-5">{prompt}</p>
          </div>
        ) : null}
        {latestAttempt ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
            <span className="text-muted-foreground">Latest activity</span>
            <StatusBadge status={latestAttempt.status} />
            <span>attempt {latestAttempt.attempt}</span>
            {latestAttempt.errorMessage ? (
              <span className="text-destructive">
                {latestAttempt.errorMessage}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <details className="rounded-lg border p-2">
            <summary className="cursor-pointer font-medium text-foreground">
              Structured input
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
              {JSON.stringify(node.structuredInput, null, 2)}
            </pre>
          </details>
          <details className="rounded-lg border p-2">
            <summary className="cursor-pointer font-medium text-foreground">
              Structured result
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
              {node.structuredResult === null
                ? "No result yet."
                : JSON.stringify(node.structuredResult, null, 2)}
            </pre>
          </details>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {node.worktreeId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenHistory(node.worktreeId!)}
            >
              <GitBranch className="size-4" /> Open Git
            </Button>
          ) : null}
          {retryable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={onRetry}
            >
              <RotateCcw className="size-4" /> Retry node
            </Button>
          ) : null}
        </div>
        <span className="sr-only">Run {runId}</span>
      </div>
    </details>
  );
}
