import type {
  GitWorktreeChangesMoveResult,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import {
  applyProjectWorktreeChangesMove,
  previewProjectWorktreeChangesMove,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export function eligibleWorktreeChangeTargets(
  source: ProjectWorktreeSummary,
  worktrees: readonly ProjectWorktreeSummary[],
): ProjectWorktreeSummary[] {
  return worktrees
    .filter(
      (worktree) =>
        worktree.id !== source.id &&
        worktree.projectSourceId === source.projectSourceId &&
        worktree.workerId === source.workerId &&
        worktree.lifecycleState === "ready",
    )
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

export function GitWorktreeChangesMoveDialog({
  onMoved,
  onOpenChange,
  open,
  projectId,
  source,
  worktrees,
}: {
  onMoved(targetWorktreeId: string, result: GitWorktreeChangesMoveResult): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  source: ProjectWorktreeSummary;
  worktrees: readonly ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const targets = useMemo(
    () => eligibleWorktreeChangeTargets(source, worktrees),
    [source, worktrees],
  );
  const [targetId, setTargetId] = useState("");
  useEffect(() => {
    if (!open) {
      setTargetId("");
      return;
    }
    if (!targets.some(({ id }) => id === targetId)) {
      setTargetId(targets[0]?.id ?? "");
    }
  }, [open, targetId, targets]);
  const preview = useQuery({
    enabled: open && Boolean(targetId),
    queryKey: ["worktree-changes-move-preview", projectId, source.id, targetId],
    queryFn: () =>
      previewProjectWorktreeChangesMove(projectId, source.id, targetId),
    retry: false,
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!targetId || !preview.data) {
        throw new Error("Review a target worktree before moving changes.");
      }
      return applyProjectWorktreeChangesMove(
        projectId,
        source.id,
        targetId,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["worktree-status", projectId, source.id],
        result.sourceStatus,
      );
      queryClient.setQueryData(
        ["worktree-status", projectId, targetId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-git-operation", projectId, targetId],
      });
      onMoved(targetId, result);
      onOpenChange(false);
    },
  });
  const target = targets.find(({ id }) => id === targetId);
  const busy = apply.isPending;
  const failure = apply.error ?? preview.error;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent showClose={!busy} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move working changes</DialogTitle>
          <DialogDescription>
            Move the complete staged, unstaged, and untracked patch from{" "}
            {source.name}
            into another clean worktree. Git preserves a recovery stash if the
            destination conflicts.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm">
          <span>Destination worktree</span>
          <NativeSelect
            value={targetId}
            disabled={busy || targets.length === 0}
            onChange={(event) => {
              apply.reset();
              setTargetId(event.target.value);
            }}
          >
            {targets.length === 0 ? (
              <option value="">No compatible worktrees</option>
            ) : null}
            {targets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} · {candidate.branch ?? "Detached HEAD"}
              </option>
            ))}
          </NativeSelect>
        </label>
        {preview.isLoading ? (
          <div className="grid h-32 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : preview.data ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">
                {preview.data.sourceBranch ??
                  preview.data.sourceHead.slice(0, 10)}
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-right font-mono">
                {preview.data.targetBranch ??
                  preview.data.targetHead.slice(0, 10)}
              </span>
            </div>
            <p className="text-sm">{preview.data.summary}</p>
            {preview.data.warnings.length ? (
              <div className="grid gap-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                {preview.data.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
            <div className="max-h-44 overflow-auto rounded-lg border p-2 font-mono text-[11px]">
              {preview.data.files.map((file) => (
                <p
                  key={`${file.path}:${file.indexStatus}:${file.worktreeStatus}`}
                  className="truncate"
                >
                  {file.indexStatus}
                  {file.worktreeStatus} {file.path}
                </p>
              ))}
            </div>
          </div>
        ) : targets.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Create another worktree on this worker before moving these changes.
          </p>
        ) : null}
        {failure ? (
          <p className="text-sm text-destructive">
            {errorMessage(failure, "The worktree changes could not be moved.")}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!target || !preview.data || busy}
            onClick={() => apply.mutate()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Move changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
