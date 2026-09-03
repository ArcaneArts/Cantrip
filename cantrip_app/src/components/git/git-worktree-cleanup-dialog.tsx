import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, GitFork, Loader2, ScanLine } from "lucide-react";
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
import {
  applyProjectWorktreeBranchAction,
  getProjectWorktreeBranches,
  getProjectWorktrees,
  previewProjectWorktreeBranchAction,
  pruneProjectWorktrees,
  removeProjectWorktree,
} from "@/lib/api";

import { planGitWorktreeCleanup } from "./git-worktree-cleanup";

interface CleanupResult {
  errors: string[];
  removedWorktreeIds: string[];
}

function cleanupKey(kind: "branch" | "worktree" | "stale", id: string) {
  return `${kind}:${id}`;
}

export function GitWorktreeCleanupDialog({
  onComplete,
  onOpenChange,
  open,
  primaryWorktreeId,
  projectId,
  worktrees,
}: {
  onComplete(result: CleanupResult): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  primaryWorktreeId: string;
  projectId: string;
  worktrees: readonly ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const inventory = useQuery({
    enabled: open,
    queryKey: ["worktree-branches", projectId, primaryWorktreeId],
    queryFn: () => getProjectWorktreeBranches(projectId, primaryWorktreeId),
    retry: false,
  });
  const plan = useMemo(
    () =>
      inventory.data
        ? planGitWorktreeCleanup(inventory.data, worktrees)
        : { branches: [], mergedWorktrees: [], staleWorktrees: [] },
    [inventory.data, worktrees],
  );
  const candidates = useMemo(
    () => [
      ...plan.mergedWorktrees.map((worktree) => ({
        key: cleanupKey("worktree", worktree.id),
        label: worktree.name,
        detail: `Remove merged worktree · ${worktree.branch}`,
        icon: GitFork,
      })),
      ...(plan.staleWorktrees.length
        ? [
            {
              key: cleanupKey("stale", "all"),
              label: `${plan.staleWorktrees.length} stale ${plan.staleWorktrees.length === 1 ? "worktree" : "worktrees"}`,
              detail: "Prune all stale managed worktree metadata",
              icon: ScanLine,
            },
          ]
        : []),
      ...plan.branches.map((branch) => ({
        key: cleanupKey("branch", branch.name),
        label: branch.name,
        detail: "Delete merged local branch",
        icon: GitBranch,
      })),
    ],
    [plan],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CleanupResult | null>(null);
  useEffect(() => {
    if (open) {
      setSelected(new Set(candidates.map(({ key }) => key)));
      setResult(null);
    }
  }, [candidates, open]);
  const cleanup = useMutation({
    mutationFn: async (): Promise<CleanupResult> => {
      const errors: string[] = [];
      const removedWorktreeIds: string[] = [];
      for (const worktree of plan.mergedWorktrees) {
        if (!selected.has(cleanupKey("worktree", worktree.id))) continue;
        try {
          await removeProjectWorktree(projectId, worktree.id, {
            allowExternal: false,
            force: false,
          });
          removedWorktreeIds.push(worktree.id);
        } catch (error) {
          errors.push(
            `${worktree.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (selected.has(cleanupKey("stale", "all"))) {
        try {
          await pruneProjectWorktrees(projectId, false);
        } catch (error) {
          errors.push(
            `Stale worktrees: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const branch of plan.branches) {
        if (!selected.has(cleanupKey("branch", branch.name))) continue;
        try {
          const action = {
            type: "deleteLocal" as const,
            name: branch.name,
            force: false,
          };
          const preview = await previewProjectWorktreeBranchAction(
            projectId,
            primaryWorktreeId,
            action,
          );
          await applyProjectWorktreeBranchAction(
            projectId,
            primaryWorktreeId,
            action,
            preview.token,
          );
        } catch (error) {
          errors.push(
            `${branch.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { errors, removedWorktreeIds };
    },
    onSuccess: async (next) => {
      setResult(next);
      const [nextWorktrees] = await Promise.all([
        getProjectWorktrees(projectId),
        queryClient.invalidateQueries({
          queryKey: ["worktree-status", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["worktree-history", projectId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["worktree-branches", projectId],
        }),
      ]);
      queryClient.setQueryData(["worktrees", projectId], nextWorktrees);
      onComplete(next);
      if (next.errors.length === 0) onOpenChange(false);
    },
  });
  const failure = cleanup.error ?? inventory.error;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!cleanup.isPending) onOpenChange(next);
      }}
    >
      <DialogContent showClose={!cleanup.isPending} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Clean up merged Git work</DialogTitle>
          <DialogDescription>
            Remove selected merged worktrees, prune stale worktree metadata, and
            delete merged local branches. Each operation rechecks the live Git
            state and refuses dirty, locked, active, or unmerged work.
          </DialogDescription>
        </DialogHeader>
        {inventory.isLoading ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : candidates.length ? (
          <div className="max-h-[50vh] overflow-auto rounded-lg border p-2">
            {candidates.map((candidate) => {
              const Icon = candidate.icon;
              return (
                <label
                  key={candidate.key}
                  className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(candidate.key)}
                    disabled={cleanup.isPending}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(candidate.key);
                        else next.delete(candidate.key);
                        return next;
                      })
                    }
                  />
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {candidate.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {candidate.detail}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            No merged branches or stale worktrees are ready to clean up.
          </p>
        )}
        {failure ? (
          <p className="text-sm text-destructive">
            {failure instanceof Error ? failure.message : String(failure)}
          </p>
        ) : null}
        {result?.errors.length ? (
          <div className="grid gap-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
            <p className="font-medium">
              Some items changed or are still in use and were left intact:
            </p>
            {result.errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={cleanup.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.size === 0 || cleanup.isPending}
            onClick={() => cleanup.mutate()}
          >
            {cleanup.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Clean up selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
