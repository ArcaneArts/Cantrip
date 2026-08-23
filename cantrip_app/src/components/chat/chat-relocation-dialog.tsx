import type {
  ChatRelocationJobSummary,
  ChatSummary,
  ProjectReplicaSummary,
  ProjectWorktreeSummary,
  UserSettings,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  GitCompareArrows,
  Loader2,
  MapPin,
  RotateCcw,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import type { WorktreeStatusMap } from "@/components/worktrees/worktree-control";
import {
  cancelChatRelocation,
  createChatRelocation,
  retryChatRelocation,
} from "@/lib/api";
import { ensureChatWorkerEncryption } from "@/lib/chat-worker-encryption";
import { errorMessage } from "@/lib/error-message";
import { chatRelocationJobMessage } from "@/lib/job-status-message";
import { cn } from "@/lib/utils";

export const activeChatRelocationStates = new Set<
  ChatRelocationJobSummary["state"]
>([
  "queued",
  "waiting-for-idle",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "blocked",
]);

export function isChatRelocationActive(
  job: ChatRelocationJobSummary | null | undefined,
): boolean {
  return Boolean(job && activeChatRelocationStates.has(job.state));
}

export function latestChatRelocationJob(
  jobs: readonly ChatRelocationJobSummary[],
): ChatRelocationJobSummary | null {
  return (
    [...jobs].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

export function activeChatRelocationJob(
  jobs: readonly ChatRelocationJobSummary[],
): ChatRelocationJobSummary | null {
  return latestChatRelocationJob(
    jobs.filter((job) => activeChatRelocationStates.has(job.state)),
  );
}

export interface ChatRelocationTargetWorktree {
  detail: string;
  disabled: boolean;
  reason: string | null;
  worktree: ProjectWorktreeSummary;
}

export interface ChatRelocationTargetWorker {
  reason: string | null;
  replica: ProjectReplicaSummary | null;
  worker: WorkerSummary;
  worktrees: ChatRelocationTargetWorktree[];
}

function shortRevision(revision: string | null | undefined): string {
  return revision ? revision.slice(0, 10) : "unknown";
}

export function chatRelocationSourceIssue(
  chat: ChatSummary,
  placement: ProjectSurfacePlacementContext,
  statuses: WorktreeStatusMap,
): string | null {
  const sourceWorktree = placement.worktrees.find(
    ({ id }) => id === chat.activeWorktreeId,
  );
  const sourceWorkerId = chat.activeWorkerId ?? sourceWorktree?.workerId;
  const sourceWorker = placement.workers.find(
    ({ workerId }) => workerId === sourceWorkerId,
  );
  if (!sourceWorker?.chatRelocation) {
    return "The current worker must be upgraded before this agent can move.";
  }
  if (!sourceWorktree || sourceWorktree.lifecycleState !== "ready") {
    return "The current agent worktree is not ready.";
  }
  if (!sourceWorktree.head) {
    return "Refresh the current worktree so its Git revision can be verified.";
  }
  if ((statuses[sourceWorktree.id]?.files.length ?? 0) > 0) {
    return "Commit or preserve the current worktree changes before moving this agent.";
  }
  return null;
}

export function chatRelocationTargetWorkers(input: {
  chat: ChatSummary;
  placement: ProjectSurfacePlacementContext;
  statuses: WorktreeStatusMap;
  synchronizationPolicy: UserSettings["automaticReplicaSynchronization"];
}): ChatRelocationTargetWorker[] {
  const sourceWorktree = input.placement.worktrees.find(
    ({ id }) => id === input.chat.activeWorktreeId,
  );
  const sourceWorkerId =
    input.chat.activeWorkerId ?? sourceWorktree?.workerId ?? null;
  return [...input.placement.workers]
    .filter(({ workerId }) => workerId !== sourceWorkerId)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.workerId.localeCompare(right.workerId),
    )
    .map((worker) => {
      const replica =
        input.placement.replicas.find(
          ({ workerId }) => workerId === worker.workerId,
        ) ?? null;
      const workerReason = !worker.chatRelocation
        ? "Upgrade required"
        : !replica
          ? "No project replica"
          : !replica.ready
            ? "Replica not ready"
            : null;
      const worktrees = input.placement.worktrees
        .filter(
          (worktree) =>
            worktree.workerId === worker.workerId &&
            worktree.lifecycleState === "ready",
        )
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            Number(right.isPrimary) - Number(left.isPrimary) ||
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        )
        .map((worktree): ChatRelocationTargetWorktree => {
          let reason = workerReason;
          let detail = worker.online
            ? `${worktree.branch ?? "Detached"} · ${shortRevision(worktree.head)}`
            : "Worker offline · relocation will wait";
          if (!reason && worktree.locked) {
            reason = worktree.lockReason ?? "Worktree locked";
          }
          if (!reason && (input.statuses[worktree.id]?.files.length ?? 0) > 0) {
            reason = "Local changes";
          }
          if (!reason && !worktree.head) {
            reason =
              "Refresh this worktree so its Git revision can be verified";
          }
          if (
            !reason &&
            sourceWorktree?.head &&
            worktree.head &&
            sourceWorktree.head !== worktree.head
          ) {
            if (!worktree.isPrimary) {
              reason = "Revision differs; reconcile this worktree first";
            } else if (input.synchronizationPolicy !== "fast-forward-primary") {
              reason = "Revision differs; safe Primary sync is off";
            } else {
              detail = `Will safely synchronize to ${shortRevision(sourceWorktree.head)}`;
            }
          }
          return {
            detail,
            disabled: reason !== null,
            reason,
            worktree,
          };
        });
      return {
        reason:
          workerReason ?? (worktrees.length === 0 ? "No ready worktree" : null),
        replica,
        worker,
        worktrees,
      };
    });
}

function stateLabel(state: ChatRelocationJobSummary["state"]): string {
  return state.replaceAll("-", " ");
}

export function ChatRelocationStatus({
  job,
  onOpen,
}: {
  job: ChatRelocationJobSummary;
  onOpen?: () => void;
}) {
  const failed = job.state === "failed" || job.state === "blocked";
  const succeeded = job.state === "succeeded";
  const content = (
    <>
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg border",
          failed && "border-destructive/40 text-destructive",
          succeeded && "border-emerald-500/40 text-emerald-500",
        )}
      >
        {failed ? (
          <CircleAlert className="size-3.5" />
        ) : succeeded ? (
          <Check className="size-3.5" />
        ) : (
          <Loader2 className="size-3.5 animate-spin" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium capitalize">
            Moving agent · {stateLabel(job.state)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {job.progress.percent}% · attempt {job.attempt}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block text-xs text-muted-foreground",
            failed && "text-destructive",
          )}
        >
          {chatRelocationJobMessage(job)}
        </span>
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full bg-foreground transition-[width]",
              failed && "bg-destructive",
              succeeded && "bg-emerald-500",
            )}
            style={{ width: `${job.progress.percent}%` }}
          />
        </span>
      </span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="flex w-full items-start gap-3 border-y px-3 py-2 text-left hover:bg-muted/40"
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <div className="flex items-start gap-3 border-y px-3 py-2">{content}</div>
  );
}

function upsertJob(
  jobs: readonly ChatRelocationJobSummary[] | undefined,
  job: ChatRelocationJobSummary,
): ChatRelocationJobSummary[] {
  return [...(jobs ?? []).filter(({ id }) => id !== job.id), job].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
}

export function ChatRelocationDialog({
  available,
  chat,
  jobs,
  jobsError,
  jobsLoading,
  open,
  onOpenChange,
  placement,
  statuses,
  synchronizationPolicy,
}: {
  available: boolean;
  chat: ChatSummary;
  jobs: readonly ChatRelocationJobSummary[];
  jobsError: unknown;
  jobsLoading: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  placement: ProjectSurfacePlacementContext;
  statuses: WorktreeStatusMap;
  synchronizationPolicy: UserSettings["automaticReplicaSynchronization"];
}) {
  const queryClient = useQueryClient();
  const requestKey = useRef<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState("");
  const sourceWorktree = placement.worktrees.find(
    ({ id }) => id === chat.activeWorktreeId,
  );
  const sourceWorkerId = chat.activeWorkerId ?? sourceWorktree?.workerId;
  const sourceWorker = placement.workers.find(
    ({ workerId }) => workerId === sourceWorkerId,
  );
  const targets = useMemo(
    () =>
      chatRelocationTargetWorkers({
        chat,
        placement,
        statuses,
        synchronizationPolicy,
      }),
    [chat, placement, statuses, synchronizationPolicy],
  );
  const targetWorktrees = useMemo(
    () =>
      targets.flatMap(({ worker, worktrees }) =>
        worktrees.map((target) => ({ ...target, worker })),
      ),
    [targets],
  );
  const selectedTarget = targetWorktrees.find(
    ({ worktree }) => worktree.id === selectedWorktreeId,
  );
  const activeJob = activeChatRelocationJob(jobs);
  const latestJob = latestChatRelocationJob(jobs);
  const sourceIssue = !available
    ? "This server does not support durable agent relocation."
    : chatRelocationSourceIssue(chat, placement, statuses);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["chat-relocation-jobs", chat.id],
      }),
      queryClient.invalidateQueries({ queryKey: ["chats", chat.projectId] }),
      queryClient.invalidateQueries({
        queryKey: ["worktrees", chat.projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
    ]);
  };
  const remember = (job: ChatRelocationJobSummary) => {
    queryClient.setQueryData<ChatRelocationJobSummary[]>(
      ["chat-relocation-jobs", chat.id],
      (current) => upsertJob(current, job),
    );
  };
  const create = useMutation({
    mutationFn: async (worktreeId: string) => {
      await ensureChatWorkerEncryption({ worker: sourceWorker });
      await ensureChatWorkerEncryption({ worker: selectedTarget?.worker });
      requestKey.current ??= crypto.randomUUID();
      return createChatRelocation(chat.id, {
        approved: true,
        idempotencyKey: requestKey.current,
        target: { kind: "worktree", projectId: chat.projectId, worktreeId },
      });
    },
    onSuccess: async (job) => {
      requestKey.current = null;
      remember(job);
      await refresh();
    },
  });
  const retry = useMutation({
    mutationFn: async (job: ChatRelocationJobSummary) => {
      await ensureChatWorkerEncryption({ worker: sourceWorker });
      await ensureChatWorkerEncryption({
        worker: placement.workers.find(
          ({ workerId }) => workerId === job.targetPlacement.workerId,
        ),
      });
      return retryChatRelocation(job.id, {
        stateRevision: job.stateRevision,
      });
    },
    onSuccess: async (job) => {
      remember(job);
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (job: ChatRelocationJobSummary) =>
      cancelChatRelocation(job.id, { stateRevision: job.stateRevision }),
    onSuccess: async (job) => {
      remember(job);
      await refresh();
    },
  });

  useEffect(() => {
    if (!open || activeJob) return;
    if (
      !targetWorktrees.some(
        ({ worktree }) => worktree.id === selectedWorktreeId,
      )
    ) {
      setSelectedWorktreeId(
        targetWorktrees.find(({ disabled }) => !disabled)?.worktree.id ?? "",
      );
    }
  }, [activeJob, open, selectedWorktreeId, targetWorktrees]);

  useEffect(() => {
    requestKey.current = null;
    create.reset();
  }, [selectedWorktreeId]);

  const mutationError =
    create.error ?? retry.error ?? cancel.error ?? jobsError;
  const canCancel = Boolean(
    activeJob &&
    !activeJob.cancellationUnsafeAt &&
    activeJob.state !== "ready-to-commit",
  );
  const canRetry = Boolean(
    latestJob?.error?.retryable &&
    (latestJob.state === "blocked" || latestJob.state === "failed"),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move agent to another worker</DialogTitle>
          <DialogDescription>
            Cantrip waits for an idle boundary, verifies both checkouts and
            runtimes, relays canonical context through the server, and changes
            placement only after the target is ready. Local changes are never
            reset or overwritten.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 border-y px-3 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <span className="text-xs text-muted-foreground">
            Current placement
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-medium">
              <MapPin className="size-3.5" />
              {sourceWorker?.name ?? "Unknown worker"}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {sourceWorktree?.name ?? "Unknown worktree"} ·{" "}
              {shortRevision(sourceWorktree?.head)}
            </span>
          </span>
        </div>

        {jobsLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading relocation
            state…
          </div>
        ) : activeJob ? (
          <ChatRelocationStatus job={activeJob} />
        ) : (
          <>
            {latestJob ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Latest relocation
                </p>
                <ChatRelocationStatus job={latestJob} />
              </div>
            ) : null}
            <div>
              <p className="mb-2 text-sm font-medium">Target placement</p>
              <div
                role="radiogroup"
                aria-label="Target worktree"
                className="divide-y border-y"
              >
                {targets.map(({ reason, worker, worktrees }) => (
                  <div key={worker.workerId}>
                    <div className="flex items-center gap-2 bg-muted/25 px-3 py-2 text-xs">
                      <span
                        className={cn(
                          "size-1.5 rounded-full bg-muted-foreground",
                          worker.online && "bg-emerald-400",
                        )}
                      />
                      <span className="font-medium">{worker.name}</span>
                      {!worker.online ? <WifiOff className="size-3" /> : null}
                      {reason ? (
                        <span className="ml-auto text-muted-foreground">
                          {reason}
                        </span>
                      ) : null}
                    </div>
                    {worktrees.map(
                      ({
                        detail,
                        disabled,
                        reason: worktreeReason,
                        worktree,
                      }) => (
                        <button
                          key={worktree.id}
                          type="button"
                          role="radio"
                          aria-checked={selectedWorktreeId === worktree.id}
                          disabled={disabled}
                          className={cn(
                            "flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50",
                            selectedWorktreeId === worktree.id && "bg-accent",
                          )}
                          onClick={() => setSelectedWorktreeId(worktree.id)}
                        >
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-full border",
                              selectedWorktreeId === worktree.id &&
                                "border-foreground after:size-2 after:rounded-full after:bg-foreground",
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              {worktree.name}
                              {worktree.isPrimary ? (
                                <Badge variant="outline">Primary</Badge>
                              ) : null}
                              {worktree.isDefault ? (
                                <Badge variant="secondary">Default</Badge>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {worktreeReason ?? detail}
                            </span>
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                ))}
                {targets.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Add a second worker replica before moving this agent.
                  </p>
                ) : null}
              </div>
            </div>
          </>
        )}

        {sourceIssue ? (
          <div className="flex gap-2 border-y border-amber-500/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{sourceIssue}</span>
          </div>
        ) : null}
        {mutationError ? (
          <div className="flex gap-2 border-y border-destructive/40 px-3 py-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{errorMessage(mutationError)}</span>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {canRetry && latestJob ? (
            <Button
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate(latestJob)}
            >
              {retry.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Retry
            </Button>
          ) : null}
          {canCancel && activeJob ? (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(activeJob)}
            >
              {cancel.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Cancel move
            </Button>
          ) : null}
          {!activeJob ? (
            <Button
              disabled={
                Boolean(sourceIssue) ||
                !selectedTarget ||
                selectedTarget.disabled ||
                create.isPending
              }
              onClick={() =>
                selectedTarget && create.mutate(selectedTarget.worktree.id)
              }
            >
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitCompareArrows className="size-4" />
              )}
              Move agent
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
