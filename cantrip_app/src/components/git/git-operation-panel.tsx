import type {
  GitManagedOperationRecord,
  GitMergeRebaseAction,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  Play,
  RotateCcw,
  SkipForward,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

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
  controlProjectWorktreeGitOperation,
  getProjectWorktreeGitOperation,
  getProjectWorktreeRevisionCandidates,
  previewProjectWorktreeGitOperation,
  startProjectWorktreeGitOperation,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";
import { GitConflictResolver } from "./git-conflict-resolver";

export function gitOperationIsActive(
  operation: GitManagedOperationRecord | null | undefined,
): boolean {
  return Boolean(
    operation &&
    ["queued", "running", "conflicted", "awaiting-user-action"].includes(
      operation.state,
    ),
  );
}

export function gitOperationControlActions(
  operation: GitManagedOperationRecord,
): Array<"continue" | "skip" | "abort"> {
  if (!gitOperationIsActive(operation)) return [];
  return operation.type === "merge" || operation.type === "stash"
    ? ["continue", "abort"]
    : ["continue", "skip", "abort"];
}

export function gitOperationSourceLabel(
  operation: GitManagedOperationRecord,
): string {
  if (operation.type !== "stash") {
    return operation.sourceRef ?? operation.sourceRevision ?? "Recorded action";
  }
  const source = operation.sourceRef ?? "stash";
  const [action, ...rest] = source.split(":");
  return `${action === "branch" ? "Create branch from" : action} ${rest.at(-1) ?? "stash"}`;
}

function OperationState({
  operation,
}: {
  operation: GitManagedOperationRecord;
}) {
  const active = gitOperationIsActive(operation);
  const Icon =
    operation.state === "completed"
      ? Check
      : operation.state === "conflicted"
        ? AlertTriangle
        : operation.state === "aborted" || operation.state === "failed"
          ? X
          : Loader2;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        operation.state === "completed"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : operation.state === "conflicted"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : operation.state === "failed"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-3",
          active && operation.state === "running" && "animate-spin",
        )}
      />
      {operation.state}
    </span>
  );
}

export function GitOperationPanel({
  initialAction,
  onClose,
  onOpenWorkingChanges,
  projectId,
  worktreeId,
}: {
  initialAction: GitMergeRebaseAction | null;
  onClose(): void;
  onOpenWorkingChanges(): void;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<GitMergeRebaseAction | null>(
    initialAction,
  );
  const [reviewedAction, setReviewedAction] =
    useState<GitMergeRebaseAction | null>(null);
  useEffect(() => {
    if (initialAction) setEditor(initialAction);
  }, [initialAction]);
  const operation = useQuery({
    queryKey: ["git-operation", projectId, worktreeId],
    queryFn: () => getProjectWorktreeGitOperation(projectId, worktreeId),
    refetchInterval: (query) =>
      gitOperationIsActive(query.state.data?.operation) ? 2_000 : false,
  });
  const refs = useQuery({
    queryKey: ["worktree-revision-candidates", projectId, worktreeId],
    queryFn: () => getProjectWorktreeRevisionCandidates(projectId, worktreeId),
  });
  const preview = useMutation({
    mutationFn: (action: GitMergeRebaseAction) =>
      previewProjectWorktreeGitOperation(projectId, worktreeId, action),
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!reviewedAction || !preview.data) {
        throw new Error("Review the operation first.");
      }
      return startProjectWorktreeGitOperation(
        projectId,
        worktreeId,
        reviewedAction,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["git-operation", projectId, worktreeId],
        result,
      );
      setReviewedAction(null);
      setEditor(null);
      preview.reset();
      invalidateGitQueries();
    },
  });
  const control = useMutation({
    mutationFn: (action: "continue" | "skip" | "abort") => {
      const current = operation.data?.operation;
      if (!current) throw new Error("No active Git operation was found.");
      return controlProjectWorktreeGitOperation(
        projectId,
        worktreeId,
        current.id,
        action,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["git-operation", projectId, worktreeId],
        result,
      );
      invalidateGitQueries();
    },
  });
  const invalidateGitQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: ["worktree-status", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-history", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-branches", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-revision-candidates", projectId, worktreeId],
    });
  };
  const current = operation.data?.operation ?? null;
  const active = gitOperationIsActive(current);
  const candidates = useMemo(
    () =>
      (refs.data ?? []).filter(
        (candidate, index, all) =>
          !candidate.current &&
          all.findIndex(({ name }) => name === candidate.name) === index,
      ),
    [refs.data],
  );
  const submitEditor = (event: FormEvent) => {
    event.preventDefault();
    if (!editor?.sourceRef.trim()) return;
    const action = { ...editor, sourceRef: editor.sourceRef.trim() };
    setReviewedAction(action);
    preview.reset();
    start.reset();
    preview.mutate(action);
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background shadow-2xl md:w-[min(48rem,78vw)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <GitPullRequestArrow className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Git operations</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Durable merge, rebase, stash, and conflict progress
          </p>
        </div>
        {!active ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditor({ type: "merge", sourceRef: "" })}
            >
              <GitMerge className="size-3.5" /> Merge
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditor({ type: "rebase", sourceRef: "" })}
            >
              <GitPullRequestArrow className="size-3.5" /> Rebase
            </Button>
          </>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close Git operations</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {operation.isLoading ? (
          <div className="grid h-48 place-items-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : operation.error ? (
          <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {operation.error instanceof Error
              ? operation.error.message
              : "Git operation state could not be loaded."}
          </p>
        ) : current ? (
          <div className="space-y-4">
            <div className="rounded-xl border p-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold capitalize">
                  {current.type}
                </p>
                <OperationState operation={current} />
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {current.currentHead.slice(0, 10)}
                </span>
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                {gitOperationSourceLabel(current)}
                {current.targetRef
                  ? ` → ${current.targetRef.replace(/^refs\/heads\//u, "")}`
                  : ""}
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.min(100, (current.currentStep / current.totalSteps) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Step {current.currentStep} of {current.totalSteps} ·{" "}
                {current.pendingCommits.length} pending
              </p>
              {current.checkpointRef ? (
                <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                  Recovery: {current.checkpointRef}
                </p>
              ) : null}
            </div>

            {current.conflictedPaths.length ? (
              <div className="space-y-2">
                <GitConflictResolver
                  projectId={projectId}
                  worktreeId={worktreeId}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onOpenWorkingChanges}
                >
                  Open Working changes
                </Button>
              </div>
            ) : null}

            {active ? (
              <div className="flex flex-wrap gap-2">
                {gitOperationControlActions(current).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    className={
                      action === "abort"
                        ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                        : undefined
                    }
                    disabled={
                      control.isPending ||
                      (action === "continue" &&
                        current.conflictedPaths.length > 0)
                    }
                    onClick={() => control.mutate(action)}
                  >
                    {action === "continue" ? (
                      <Play className="size-3.5" />
                    ) : action === "skip" ? (
                      <SkipForward className="size-3.5" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    <span className="capitalize">{action}</span>
                  </Button>
                ))}
              </div>
            ) : null}
            {control.error ? (
              <p className="text-sm text-destructive">
                {control.error instanceof Error
                  ? control.error.message
                  : "Git operation control failed."}
              </p>
            ) : null}
            {current.error ? (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {current.error}
              </p>
            ) : null}
            {current.output ? (
              <pre className="max-h-64 overflow-auto rounded-xl bg-muted/30 p-3 text-[11px] whitespace-pre-wrap text-muted-foreground">
                {current.output}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="grid h-48 place-items-center text-center text-sm text-muted-foreground">
            No merge or rebase has been recorded for this worktree yet.
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !start.isPending) {
            setEditor(null);
            setReviewedAction(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="capitalize">
              {editor?.type ?? "Git"} current branch
            </DialogTitle>
            <DialogDescription>
              Select the source, review the exact effect, then start the durable
              operation.
            </DialogDescription>
          </DialogHeader>
          {!reviewedAction ? (
            <form onSubmit={submitEditor}>
              <div className="grid gap-3 py-4">
                <select
                  autoFocus
                  aria-label="Operation source ref"
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={editor?.sourceRef ?? ""}
                  onChange={(event) =>
                    editor &&
                    setEditor({ ...editor, sourceRef: event.target.value })
                  }
                >
                  <option value="">Select a branch or tag</option>
                  {candidates.map((candidate) => (
                    <option
                      key={`${candidate.kind}:${candidate.name}`}
                      value={candidate.name}
                    >
                      {candidate.name} · {candidate.shortHash}
                    </option>
                  ))}
                </select>
                <input
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  placeholder="Or enter a revision"
                  value={editor?.sourceRef ?? ""}
                  onChange={(event) =>
                    editor &&
                    setEditor({ ...editor, sourceRef: event.target.value })
                  }
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!editor?.sourceRef.trim()}>
                  Review operation
                </Button>
              </DialogFooter>
            </form>
          ) : preview.isPending ? (
            <div className="grid h-64 place-items-center">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {preview.error instanceof Error
                  ? preview.error.message
                  : "Operation preview failed."}
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setReviewedAction(null)}
                >
                  Back
                </Button>
              </DialogFooter>
            </div>
          ) : preview.data ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="shrink-0 space-y-1 rounded-lg bg-muted/30 p-3 text-xs">
                <p className="font-medium">{preview.data.summary}</p>
                <p className="text-muted-foreground">
                  {preview.data.context.totalSteps} steps ·{" "}
                  {preview.data.files.length} affected files
                </p>
                {preview.data.warnings.map((warning) => (
                  <p
                    key={warning}
                    className="text-amber-700 dark:text-amber-300"
                  >
                    {warning}
                  </p>
                ))}
                {preview.data.context.checkpointRef ? (
                  <p className="break-all font-mono text-muted-foreground">
                    Recovery: {preview.data.context.checkpointRef}
                  </p>
                ) : null}
              </div>
              <div className="min-h-64 flex-1 overflow-hidden rounded-lg border">
                <GitPatchView
                  error={null}
                  loading={false}
                  newLabel="After operation"
                  oldLabel="Current HEAD"
                  onClose={() => undefined}
                  patch={preview.data.patch}
                  path={`${reviewedAction.type} preview`}
                  showClose={false}
                  subtitle="Exact selected-worktree patch"
                  truncated={preview.data.patchTruncated}
                />
              </div>
              {start.error ? (
                <p className="text-sm text-destructive">
                  {start.error instanceof Error
                    ? start.error.message
                    : "Git operation failed to start."}
                </p>
              ) : null}
              <DialogFooter className="shrink-0">
                <Button
                  variant="outline"
                  disabled={start.isPending}
                  onClick={() => setReviewedAction(null)}
                >
                  Back
                </Button>
                <Button
                  disabled={start.isPending}
                  className={
                    preview.data.destructive
                      ? "bg-destructive text-white hover:bg-destructive/90"
                      : undefined
                  }
                  onClick={() => start.mutate()}
                >
                  {start.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  Start {reviewedAction.type}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
