import type { GitAction, GitFileChange, GitStatus } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranchPlus,
  Loader2,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

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
  getProjectWorktreeFileDiff,
  runProjectWorktreeGitAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { buildGitChangeTree, type GitChangeTreeNode } from "./git-change-tree";
import { GitFileDiffView } from "./git-file-diff-view";

type ChangeScope = "unstaged" | "staged";

interface SelectedChange {
  path: string;
  scope: ChangeScope;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Git operation failed.";
}

function changeLabel(change: GitFileChange, staged: boolean): string {
  const code = staged ? change.indexStatus : change.worktreeStatus;
  if (code === "?") return "Untracked";
  if (code === "A") return "Added";
  if (code === "D") return "Deleted";
  if (code === "R") return "Renamed";
  if (code === "C") return "Copied";
  if (code === "U") return "Conflict";
  return "Modified";
}

function ChangeRow({
  change,
  depth,
  disabled,
  onAction,
  onDiscard,
  onSelect,
  selected,
  staged,
}: {
  change: GitFileChange;
  depth: number;
  disabled: boolean;
  onAction(): void;
  onDiscard?(): void;
  onSelect(): void;
  selected: boolean;
  staged: boolean;
}) {
  const label = changeLabel(change, staged);
  const conflicted = label === "Conflict";
  return (
    <div
      data-high-contrast-row
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs hover:bg-muted/60",
        selected && "bg-muted text-foreground",
      )}
    >
      <button
        type="button"
        className="flex h-8 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={onSelect}
        title={`Show ${staged ? "staged" : "unstaged"} diff for ${change.path}`}
      >
        <span
          className={cn(
            "w-4 shrink-0 text-center font-mono font-semibold",
            label === "Added" && "text-emerald-600 dark:text-emerald-400",
            label === "Deleted" && "text-destructive",
            label === "Conflict" && "text-amber-600 dark:text-amber-400",
            ["Modified", "Renamed", "Copied"].includes(label) &&
              "text-blue-600 dark:text-blue-400",
          )}
          title={label}
        >
          {label[0]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono">
            {change.path.split("/").at(-1)}
          </span>
          {change.originalPath ? (
            <span className="block truncate text-[10px] text-muted-foreground">
              from {change.originalPath}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center pr-1">
        {onDiscard ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground opacity-60 hover:text-destructive group-hover:opacity-100"
            disabled={disabled || conflicted}
            onClick={onDiscard}
            title={
              conflicted
                ? "Resolve conflicts before discarding this change"
                : `Discard changes in ${change.path}`
            }
          >
            <Trash2 className="size-3.5" />
            <span className="sr-only">Discard {change.path}</span>
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-7 opacity-70 group-hover:opacity-100"
          disabled={disabled}
          onClick={onAction}
          title={staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
        >
          {staged ? (
            <Minus className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          <span className="sr-only">
            {staged ? "Unstage" : "Stage"} {change.path}
          </span>
        </Button>
      </div>
    </div>
  );
}

function ChangeTree({
  changes,
  disabled,
  onAction,
  onDiscard,
  onSelect,
  selected,
  staged,
}: {
  changes: GitFileChange[];
  disabled: boolean;
  onAction(change: GitFileChange): void;
  onDiscard?(change: GitFileChange): void;
  onSelect(change: GitFileChange): void;
  selected: SelectedChange | null;
  staged: boolean;
}) {
  const tree = useMemo(() => buildGitChangeTree(changes), [changes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const renderNode = (node: GitChangeTreeNode, depth: number) => {
    if (node.type === "file") {
      return (
        <ChangeRow
          key={node.path}
          change={node.change}
          depth={depth}
          staged={staged}
          selected={
            selected?.path === node.path &&
            selected.scope === (staged ? "staged" : "unstaged")
          }
          disabled={disabled}
          onSelect={() => onSelect(node.change)}
          onDiscard={onDiscard ? () => onDiscard(node.change) : undefined}
          onAction={() => onAction(node.change)}
        />
      );
    }
    const closed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        <button
          type="button"
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          style={{ paddingLeft: `${6 + depth * 16}px` }}
          aria-expanded={!closed}
          onClick={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (closed) next.delete(node.path);
              else next.add(node.path);
              return next;
            })
          }
        >
          {closed ? (
            <ChevronRight className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
          {closed ? (
            <Folder className="size-3.5 shrink-0" />
          ) : (
            <FolderOpen className="size-3.5 shrink-0" />
          )}
          <span className="truncate font-mono">{node.name}</span>
        </button>
        {closed
          ? null
          : node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="grid gap-0.5">
      {tree.map((node) => renderNode(node, 0))}
    </div>
  );
}

export function GitChangesPanel({
  onClose,
  projectId,
  status,
  worktreeId,
  worktreeName,
}: {
  onClose(): void;
  projectId: string;
  status: GitStatus;
  worktreeId: string;
  worktreeName: string;
}) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [discardTarget, setDiscardTarget] = useState<
    GitFileChange | "all" | null
  >(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedChange | null>(null);
  const action = useMutation({
    mutationFn: (input: GitAction) =>
      runProjectWorktreeGitAction(projectId, worktreeId, input),
    onSuccess: (result, input) => {
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-file-diff", projectId, worktreeId],
      });
      setSelected((current) => {
        if (!current) return null;
        const stillExists = result.status.files.some(
          (change) =>
            change.path === current.path &&
            (current.scope === "staged" ? change.staged : change.unstaged),
        );
        return stillExists ? current : null;
      });
      setNotice(result.output || "Git operation complete.");
      if (input.type === "commit") setCommitMessage("");
      if (input.type === "discard" || input.type === "discardAll") {
        setDiscardTarget(null);
      }
      if (input.type === "createBranch") {
        setNewBranchName("");
        setNewBranchOpen(false);
      }
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
    },
  });
  const unstaged = status.files.filter((file) => file.unstaged);
  const staged = status.files.filter((file) => file.staged);
  const localBranches = status.branches.filter(
    (branch) => branch.kind === "local",
  );
  const remoteBranches = status.branches.filter(
    (branch) => branch.kind === "remote",
  );
  const busy = action.isPending;
  const diff = useQuery({
    enabled: selected !== null,
    queryKey: [
      "worktree-file-diff",
      projectId,
      worktreeId,
      selected?.path,
      selected?.scope,
    ],
    queryFn: () => {
      if (!selected) throw new Error("No changed file is selected.");
      return getProjectWorktreeFileDiff(
        projectId,
        worktreeId,
        selected.path,
        selected.scope,
      );
    },
  });

  useEffect(() => {
    if (
      selected &&
      !status.files.some(
        (change) =>
          change.path === selected.path &&
          (selected.scope === "staged" ? change.staged : change.unstaged),
      )
    ) {
      setSelected(null);
    }
  }, [selected, status.files]);

  const submitCommit = (event: FormEvent, all: boolean) => {
    event.preventDefault();
    const message = commitMessage.trim();
    if (!message) return;
    action.mutate({ type: "commit", message, all });
  };

  const createBranch = (event: FormEvent) => {
    event.preventDefault();
    const name = newBranchName.trim();
    if (name) action.mutate({ type: "createBranch", name });
  };

  const confirmDiscard = () => {
    if (discardTarget === "all") action.mutate({ type: "discardAll" });
    else if (discardTarget) {
      action.mutate({ type: "discard", paths: [discardTarget.path] });
    }
  };

  const openDiscard = (target: GitFileChange | "all") => {
    action.reset();
    setNotice(null);
    setDiscardTarget(target);
  };

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-full max-w-full shrink-0 overflow-hidden border-l bg-background shadow-2xl md:relative md:z-auto md:shadow-none",
        selected
          ? "md:w-[min(72rem,78vw)]"
          : "sm:max-w-sm md:w-96 md:max-w-none",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        {selected ? (
          <GitFileDiffView
            path={selected.path}
            scope={selected.scope}
            diff={diff.data}
            error={diff.error}
            loading={diff.isLoading}
            onClose={() => setSelected(null)}
          />
        ) : null}

        <div
          className={cn(
            "min-h-0 min-w-0 flex-col bg-background",
            selected
              ? "hidden md:flex md:w-96 md:shrink-0"
              : "flex w-full md:w-96",
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                Working changes · {worktreeName}
              </p>
              <p className="truncate text-[10px] text-muted-foreground">
                {status.files.length} changed{" "}
                {status.files.length === 1 ? "file" : "files"}
                {status.upstream
                  ? ` · ${status.ahead} ahead, ${status.behind} behind`
                  : " · no upstream"}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              disabled={busy || unstaged.length === 0}
              onClick={() => openDiscard("all")}
              title="Discard all unstaged changes"
            >
              <Trash2 className="size-4" />
              <span className="sr-only">Discard all unstaged changes</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              onClick={onClose}
            >
              <X className="size-4" />
              <span className="sr-only">Close Git changes</span>
            </Button>
          </div>

          <div className="grid min-w-0 shrink-0 gap-2 overflow-hidden border-b p-3">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <select
                aria-label="Current Git branch"
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                value={status.branch}
                disabled={busy}
                onChange={(event) =>
                  action.mutate({
                    type: "checkout",
                    branch: event.target.value,
                  })
                }
              >
                {status.branch ? null : <option value="">Detached HEAD</option>}
                <optgroup label="Local branches">
                  {localBranches.map((branch) => (
                    <option key={`local:${branch.name}`} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </optgroup>
                {remoteBranches.length > 0 ? (
                  <optgroup label="Remote branches">
                    {remoteBranches.map((branch) => (
                      <option key={`remote:${branch.name}`} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <Button
                size="icon"
                variant="outline"
                className="size-9"
                disabled={busy}
                onClick={() => {
                  action.reset();
                  setNotice(null);
                  setNewBranchOpen(true);
                }}
                title="Create branch"
              >
                <GitBranchPlus className="size-4" />
                <span className="sr-only">Create branch</span>
              </Button>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                className="min-w-0 overflow-hidden"
                disabled={busy}
                onClick={() => action.mutate({ type: "pull" })}
              >
                <ArrowDownToLine className="size-3.5" />
                <span className="truncate">
                  Pull{status.behind > 0 ? ` (${status.behind})` : ""}
                </span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-w-0 overflow-hidden"
                disabled={busy}
                onClick={() => action.mutate({ type: "push" })}
              >
                <ArrowUpFromLine className="size-3.5" />
                <span className="truncate">
                  Push{status.ahead > 0 ? ` (${status.ahead})` : ""}
                </span>
              </Button>
            </div>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
            <section>
              <div className="mb-1 flex h-8 min-w-0 items-center justify-between gap-2">
                <h2 className="truncate text-xs font-semibold">
                  Unstaged ({unstaged.length})
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 text-xs"
                  disabled={busy || unstaged.length === 0}
                  onClick={() => action.mutate({ type: "stageAll" })}
                >
                  Stage all
                </Button>
              </div>
              {unstaged.length > 0 ? (
                <ChangeTree
                  changes={unstaged}
                  staged={false}
                  selected={selected}
                  disabled={busy}
                  onSelect={(change) =>
                    setSelected({ path: change.path, scope: "unstaged" })
                  }
                  onDiscard={openDiscard}
                  onAction={(change) =>
                    action.mutate({ type: "stage", paths: [change.path] })
                  }
                />
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No unstaged changes.
                </p>
              )}
            </section>

            <section className="mt-3 border-t pt-2">
              <div className="mb-1 flex h-8 min-w-0 items-center justify-between gap-2">
                <h2 className="truncate text-xs font-semibold">
                  Staged ({staged.length})
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 text-xs"
                  disabled={busy || staged.length === 0}
                  onClick={() => action.mutate({ type: "unstageAll" })}
                >
                  Unstage all
                </Button>
              </div>
              {staged.length > 0 ? (
                <ChangeTree
                  changes={staged}
                  staged
                  selected={selected}
                  disabled={busy}
                  onSelect={(change) =>
                    setSelected({ path: change.path, scope: "staged" })
                  }
                  onAction={(change) =>
                    action.mutate({ type: "unstage", paths: [change.path] })
                  }
                />
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No staged changes.
                </p>
              )}
            </section>
          </div>

          <form className="grid min-w-0 shrink-0 gap-2 border-t p-3">
            <textarea
              aria-label="Commit message"
              className="min-h-20 min-w-0 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              placeholder="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            {action.error ? (
              <p className="text-xs text-destructive">
                {errorText(action.error)}
              </p>
            ) : notice ? (
              <p
                className="line-clamp-2 text-xs text-muted-foreground"
                title={notice}
              >
                {notice}
              </p>
            ) : null}
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <Button
                type="submit"
                size="sm"
                className="min-w-0 overflow-hidden"
                disabled={busy || staged.length === 0 || !commitMessage.trim()}
                onClick={(event) => submitCommit(event, false)}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                <span className="truncate">Commit staged</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-w-0 overflow-hidden"
                disabled={
                  busy || status.files.length === 0 || !commitMessage.trim()
                }
                onClick={(event) => submitCommit(event, true)}
              >
                <span className="truncate">Commit all</span>
              </Button>
            </div>
          </form>
        </div>
      </div>

      <Dialog
        open={discardTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDiscardTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {discardTarget === "all"
                ? `Discard all ${unstaged.length} unstaged changes?`
                : `Discard changes in ${discardTarget?.path ?? "this file"}?`}
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Staged changes will be preserved, but
              matching untracked files will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          {action.error ? (
            <p className="text-sm text-destructive">
              {errorText(action.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDiscardTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={confirmDiscard}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Create and switch to a new branch from the current commit.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={createBranch}>
            <input
              autoFocus
              aria-label="New branch name"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              placeholder="feature/my-change"
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
            {action.error ? (
              <p className="text-xs text-destructive">
                {errorText(action.error)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewBranchOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !newBranchName.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Create branch
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
