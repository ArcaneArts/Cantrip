import type { GitAction, GitFileChange, GitStatus } from "@cantrip/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitBranchPlus,
  Loader2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { runGitAction } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  disabled,
  onAction,
  staged,
}: {
  change: GitFileChange;
  disabled: boolean;
  onAction(): void;
  staged: boolean;
}) {
  const label = changeLabel(change, staged);
  return (
    <div
      data-high-contrast-row
      className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60"
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
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono" title={change.path}>
          {change.path}
        </p>
        {change.originalPath ? (
          <p className="truncate text-[10px] text-muted-foreground">
            from {change.originalPath}
          </p>
        ) : null}
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
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
  );
}

export function GitChangesPanel({
  onClose,
  projectId,
  status,
}: {
  onClose(): void;
  projectId: string;
  status: GitStatus;
}) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: (input: GitAction) => runGitAction(projectId, input),
    onSuccess: (result, input) => {
      queryClient.setQueryData(["git-status", projectId], result.status);
      setNotice(result.output || "Git operation complete.");
      if (input.type === "commit") setCommitMessage("");
      if (input.type === "createBranch") {
        setNewBranchName("");
        setNewBranchOpen(false);
      }
      void queryClient.invalidateQueries({
        queryKey: ["git-history", projectId],
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

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l bg-background shadow-2xl md:relative md:z-auto md:w-96 md:shadow-none">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Working changes</p>
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
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close Git changes</span>
        </Button>
      </div>

      <div className="grid shrink-0 gap-2 border-b p-3">
        <div className="flex gap-2">
          <select
            aria-label="Current Git branch"
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            value={status.branch}
            disabled={busy}
            onChange={(event) =>
              action.mutate({ type: "checkout", branch: event.target.value })
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
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate({ type: "pull" })}
          >
            <ArrowDownToLine className="size-3.5" /> Pull
            {status.behind > 0 ? ` (${status.behind})` : ""}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => action.mutate({ type: "push" })}
          >
            <ArrowUpFromLine className="size-3.5" /> Push
            {status.ahead > 0 ? ` (${status.ahead})` : ""}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <section>
          <div className="mb-1 flex h-8 items-center justify-between">
            <h2 className="text-xs font-semibold">
              Unstaged ({unstaged.length})
            </h2>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy || unstaged.length === 0}
              onClick={() => action.mutate({ type: "stageAll" })}
            >
              Stage all
            </Button>
          </div>
          {unstaged.length > 0 ? (
            <div className="grid gap-0.5">
              {unstaged.map((change) => (
                <ChangeRow
                  key={`unstaged:${change.path}`}
                  change={change}
                  staged={false}
                  disabled={busy}
                  onAction={() =>
                    action.mutate({ type: "stage", paths: [change.path] })
                  }
                />
              ))}
            </div>
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No unstaged changes.
            </p>
          )}
        </section>

        <section className="mt-3 border-t pt-2">
          <div className="mb-1 flex h-8 items-center justify-between">
            <h2 className="text-xs font-semibold">Staged ({staged.length})</h2>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy || staged.length === 0}
              onClick={() => action.mutate({ type: "unstageAll" })}
            >
              Unstage all
            </Button>
          </div>
          {staged.length > 0 ? (
            <div className="grid gap-0.5">
              {staged.map((change) => (
                <ChangeRow
                  key={`staged:${change.path}`}
                  change={change}
                  staged
                  disabled={busy}
                  onAction={() =>
                    action.mutate({ type: "unstage", paths: [change.path] })
                  }
                />
              ))}
            </div>
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No staged changes.
            </p>
          )}
        </section>
      </div>

      <form className="grid shrink-0 gap-2 border-t p-3">
        <textarea
          aria-label="Commit message"
          className="min-h-20 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          placeholder="Commit message"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
        />
        {action.error ? (
          <p className="text-xs text-destructive">{errorText(action.error)}</p>
        ) : notice ? (
          <p
            className="line-clamp-2 text-xs text-muted-foreground"
            title={notice}
          >
            {notice}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={busy || staged.length === 0 || !commitMessage.trim()}
            onClick={(event) => submitCommit(event, false)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Commit staged
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              busy || status.files.length === 0 || !commitMessage.trim()
            }
            onClick={(event) => submitCommit(event, true)}
          >
            Commit all
          </Button>
        </div>
      </form>

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
