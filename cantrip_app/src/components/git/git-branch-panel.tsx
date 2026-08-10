import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  GitBranchAction,
  GitBranchList,
  GitManagedBranch,
  GitMergeRebaseAction,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  CloudUpload,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
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
  applyProjectWorktreeBranchAction,
  getProjectWorktreeBranches,
  previewProjectWorktreeBranchAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

function branchAge(value: string, now = Date.now()): string {
  const minutes = Math.round((new Date(value).getTime() - now) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relativeTime.format(days, "day");
  return new Date(value).toLocaleDateString();
}

export function filterManagedBranches(
  branches: GitManagedBranch[],
  kind: "local" | "remote",
  search: string,
): GitManagedBranch[] {
  const query = search.trim().toLocaleLowerCase();
  return branches.filter(
    (branch) =>
      branch.kind === kind &&
      (!query ||
        branch.name.toLocaleLowerCase().includes(query) ||
        branch.upstream?.toLocaleLowerCase().includes(query) ||
        branch.lastCommit.subject.toLocaleLowerCase().includes(query) ||
        branch.lastCommit.authorName.toLocaleLowerCase().includes(query)),
  );
}

export function branchStateLabel(branch: GitManagedBranch): string {
  if (branch.worktree && !branch.worktree.current)
    return `owned by ${branch.worktree.label}`;
  if (branch.kind === "remote") {
    return branch.trackingLocalBranches.length
      ? `tracked by ${branch.trackingLocalBranches.join(", ")}`
      : "remote only";
  }
  if (branch.upstreamGone) return "upstream gone";
  if (branch.ahead || branch.behind)
    return `${branch.ahead} ahead · ${branch.behind} behind`;
  if (branch.upstream) return "up to date";
  return "unpublished";
}

export function branchActionDescription(action: GitBranchAction): string {
  switch (action.type) {
    case "create":
      return `${action.checkout ? "Create and switch to" : "Create"} ${action.name}${action.startPoint ? ` from ${action.startPoint}` : " from HEAD"}.`;
    case "switch":
      return `Switch this worktree to ${action.name}.`;
    case "publish":
      return `Push ${action.name} to ${action.remote} and configure upstream tracking.`;
    case "rename":
      return `Rename ${action.name} to ${action.newName}.`;
    case "deleteLocal":
      return `${action.force ? "Force-delete" : "Delete"} local branch ${action.name}.`;
    case "deleteRemote":
      return `Delete ${action.remote}/${action.name} from the remote.`;
    case "setUpstream":
      return action.upstream
        ? `Track ${action.upstream} from ${action.name}.`
        : `Remove upstream tracking from ${action.name}.`;
    case "fetch":
      return `${action.prune ? "Fetch and prune" : "Fetch"} ${action.remote ?? "all remotes"}.`;
  }
}

type EditorState =
  | { type: "create"; name: string; startPoint: string; checkout: boolean }
  | { type: "rename"; branch: GitManagedBranch; value: string }
  | { type: "publish"; branch: GitManagedBranch; remote: string }
  | { type: "upstream"; branch: GitManagedBranch; upstream: string }
  | { type: "deleteLocal"; branch: GitManagedBranch; force: boolean }
  | { type: "deleteRemote"; branch: GitManagedBranch };

function actionFromEditor(editor: EditorState): GitBranchAction {
  switch (editor.type) {
    case "create":
      return {
        type: "create",
        name: editor.name.trim(),
        startPoint: editor.startPoint || null,
        checkout: editor.checkout,
      };
    case "rename":
      return {
        type: "rename",
        name: editor.branch.name,
        newName: editor.value.trim(),
      };
    case "publish":
      return {
        type: "publish",
        name: editor.branch.name,
        remote: editor.remote,
      };
    case "upstream":
      return {
        type: "setUpstream",
        name: editor.branch.name,
        upstream: editor.upstream || null,
      };
    case "deleteLocal":
      return {
        type: "deleteLocal",
        name: editor.branch.name,
        force: editor.force,
      };
    case "deleteRemote": {
      const remote = editor.branch.remoteName ?? "";
      return {
        type: "deleteRemote",
        remote,
        name: editor.branch.name.slice(remote.length + 1),
      };
    }
  }
}

function BranchActions({
  branch,
  disabled,
  inventory,
  onEdit,
  onOperation,
  onReview,
}: {
  branch: GitManagedBranch;
  disabled: boolean;
  inventory: GitBranchList;
  onEdit(editor: EditorState): void;
  onOperation(action: GitMergeRebaseAction): void;
  onReview(action: GitBranchAction): void;
}) {
  const itemClass =
    "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
  const blockedByWorktree = Boolean(
    branch.worktree && !branch.worktree.current,
  );
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={disabled}
        >
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">Actions for {branch.name}</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {!branch.current ? (
            <>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                disabled={blockedByWorktree}
                onSelect={() =>
                  onReview({
                    type: "switch",
                    name: branch.name,
                    kind: branch.kind,
                  })
                }
              >
                <ArrowRightLeft className="size-3.5" /> Switch here
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={() =>
                  onOperation({ type: "merge", sourceRef: branch.name })
                }
              >
                <GitMerge className="size-3.5" /> Merge into current
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={() =>
                  onOperation({ type: "rebase", sourceRef: branch.name })
                }
              >
                <GitPullRequestArrow className="size-3.5" /> Rebase current onto
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}
          {branch.kind === "local" ? (
            <>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                disabled={!inventory.remotes.length}
                onSelect={() =>
                  onEdit({
                    type: "publish",
                    branch,
                    remote:
                      inventory.defaultRemote ?? inventory.remotes[0] ?? "",
                  })
                }
              >
                <CloudUpload className="size-3.5" /> Publish
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                disabled={blockedByWorktree}
                onSelect={() =>
                  onEdit({ type: "rename", branch, value: branch.name })
                }
              >
                Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={() =>
                  onEdit({
                    type: "upstream",
                    branch,
                    upstream: branch.upstream ?? "",
                  })
                }
              >
                Change upstream
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  itemClass,
                  "text-destructive focus:text-destructive",
                )}
                disabled={branch.current || blockedByWorktree}
                onSelect={() =>
                  onEdit({ type: "deleteLocal", branch, force: false })
                }
              >
                <Trash2 className="size-3.5" /> Delete local
              </DropdownMenuPrimitive.Item>
            </>
          ) : (
            <DropdownMenuPrimitive.Item
              className={cn(
                itemClass,
                "text-destructive focus:text-destructive",
              )}
              onSelect={() => onEdit({ type: "deleteRemote", branch })}
            >
              <Trash2 className="size-3.5" /> Delete remote
            </DropdownMenuPrimitive.Item>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function GitBranchPanel({
  onClose,
  onOperation,
  projectId,
  worktreeId,
}: {
  onClose(): void;
  onOperation(action: GitMergeRebaseAction): void;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"local" | "remote">("local");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [reviewedAction, setReviewedAction] = useState<GitBranchAction | null>(
    null,
  );
  const branches = useQuery({
    queryKey: ["worktree-branches", projectId, worktreeId],
    queryFn: () => getProjectWorktreeBranches(projectId, worktreeId),
  });
  const preview = useMutation({
    mutationFn: (action: GitBranchAction) =>
      previewProjectWorktreeBranchAction(projectId, worktreeId, action),
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!reviewedAction || !preview.data)
        throw new Error("Review a branch action first.");
      return applyProjectWorktreeBranchAction(
        projectId,
        worktreeId,
        reviewedAction,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["worktree-branches", projectId, worktreeId],
        result.branches,
      );
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-status", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-revision-candidates", projectId, worktreeId],
      });
      setReviewedAction(null);
      preview.reset();
    },
  });
  const review = (action: GitBranchAction) => {
    setReviewedAction(action);
    preview.reset();
    apply.reset();
    preview.mutate(action);
  };
  const submitEditor = (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const action = actionFromEditor(editor);
    if (
      ("name" in action && !action.name) ||
      (action.type === "rename" && !action.newName)
    )
      return;
    setEditor(null);
    review(action);
  };
  const shown = useMemo(
    () => filterManagedBranches(branches.data?.branches ?? [], kind, search),
    [branches.data?.branches, kind, search],
  );
  const localCount =
    branches.data?.branches.filter(({ kind }) => kind === "local").length ?? 0;
  const remoteCount =
    branches.data?.branches.filter(({ kind }) => kind === "remote").length ?? 0;
  const busy = preview.isPending || apply.isPending;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background shadow-2xl md:w-[min(48rem,78vw)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <GitBranch className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Branches</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {branches.data?.currentBranch ?? "Detached HEAD"} ·{" "}
            {branches.data?.pullStrategy.description ??
              "Loading pull strategy…"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          disabled={!branches.data || busy}
          onClick={() =>
            setEditor({
              type: "create",
              name: "",
              startPoint: "",
              checkout: true,
            })
          }
        >
          <GitBranchPlus className="size-3.5" /> New
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs"
          disabled={!branches.data?.remotes.length || busy}
          onClick={() => review({ type: "fetch", remote: null, prune: false })}
        >
          <RefreshCw className="size-3.5" /> Fetch
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={!branches.data?.remotes.length || busy}
          onClick={() => review({ type: "fetch", remote: null, prune: true })}
        >
          Prune…
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close branches</span>
        </Button>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex rounded-md bg-muted/50 p-px">
          {(["local", "remote"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === kind}
              className={cn(
                "h-7 rounded px-3 text-xs capitalize text-muted-foreground",
                candidate === kind &&
                  "bg-background font-medium text-foreground shadow-sm",
              )}
              onClick={() => setKind(candidate)}
            >
              {candidate} ({candidate === "local" ? localCount : remoteCount})
            </button>
          ))}
        </div>
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Search branches"
            className="h-8 pl-8 text-xs"
            placeholder="Search branches, commits, or authors"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {branches.isLoading ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : branches.error ? (
          <p className="p-4 text-xs text-destructive">
            {branches.error instanceof Error
              ? branches.error.message
              : "Branches could not be loaded."}
          </p>
        ) : shown.length ? (
          shown.map((branch) => (
            <div
              key={branch.fullRef}
              data-high-contrast-row
              className={cn(
                "grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40",
                branch.current && "bg-primary/5",
              )}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs font-medium">
                    {branch.name}
                  </span>
                  {branch.current ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                      current
                    </span>
                  ) : null}
                  {branch.worktree && !branch.worktree.current ? (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">
                      {branch.worktree.label}
                    </span>
                  ) : null}
                  {branch.kind === "local" ? (
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[9px]",
                        branch.mergedIntoHead
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {branch.mergedIntoHead ? "merged" : "unmerged"}
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-[10px] text-muted-foreground">
                  {branchStateLabel(branch)} · {branch.lastCommit.shortHash} ·{" "}
                  {branch.lastCommit.subject} ·{" "}
                  {branchAge(branch.lastCommit.authoredAt)}
                </p>
              </div>
              <BranchActions
                branch={branch}
                disabled={busy}
                inventory={branches.data!}
                onEdit={setEditor}
                onOperation={onOperation}
                onReview={review}
              />
            </div>
          ))
        ) : (
          <div className="grid h-48 place-items-center p-5 text-center text-xs text-muted-foreground">
            No {kind} branches match this search.
          </div>
        )}
        {branches.data?.truncated ? (
          <p className="p-3 text-[10px] text-amber-600">
            Only the first 20,000 refs are shown.
          </p>
        ) : null}
      </div>

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <form onSubmit={submitEditor}>
            <DialogHeader>
              <DialogTitle>
                {editor?.type === "create"
                  ? "Create branch"
                  : editor?.type === "rename"
                    ? "Rename branch"
                    : editor?.type === "publish"
                      ? "Publish branch"
                      : editor?.type === "upstream"
                        ? "Change upstream"
                        : editor?.type === "deleteRemote"
                          ? "Delete remote branch"
                          : "Delete local branch"}
              </DialogTitle>
              <DialogDescription>
                Configure the action, then review the exact Git operation before
                it runs.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              {editor?.type === "create" ? (
                <>
                  <Input
                    autoFocus
                    placeholder="feature/name"
                    value={editor.name}
                    onChange={(event) =>
                      setEditor({ ...editor, name: event.target.value })
                    }
                  />
                  <select
                    aria-label="Branch start point"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={editor.startPoint}
                    onChange={(event) =>
                      setEditor({ ...editor, startPoint: event.target.value })
                    }
                  >
                    <option value="">Current HEAD</option>
                    {branches.data?.branches.map((branch) => (
                      <option key={branch.fullRef} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editor.checkout}
                      onChange={(event) =>
                        setEditor({ ...editor, checkout: event.target.checked })
                      }
                    />
                    Switch this worktree to the new branch
                  </label>
                </>
              ) : editor?.type === "rename" ? (
                <Input
                  autoFocus
                  value={editor.value}
                  onChange={(event) =>
                    setEditor({ ...editor, value: event.target.value })
                  }
                />
              ) : editor?.type === "publish" ? (
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={editor.remote}
                  onChange={(event) =>
                    setEditor({ ...editor, remote: event.target.value })
                  }
                >
                  {branches.data?.remotes.map((remote) => (
                    <option key={remote}>{remote}</option>
                  ))}
                </select>
              ) : editor?.type === "upstream" ? (
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={editor.upstream}
                  onChange={(event) =>
                    setEditor({ ...editor, upstream: event.target.value })
                  }
                >
                  <option value="">No upstream</option>
                  {branches.data?.branches
                    .filter(({ kind }) => kind === "remote")
                    .map((branch) => (
                      <option key={branch.fullRef} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                </select>
              ) : editor?.type === "deleteLocal" ? (
                <>
                  <p className="text-sm">
                    Delete{" "}
                    <span className="font-mono">{editor.branch.name}</span>.
                  </p>
                  {!editor.branch.mergedIntoHead ? (
                    <label className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={editor.force}
                        onChange={(event) =>
                          setEditor({ ...editor, force: event.target.checked })
                        }
                      />
                      Force-delete this unmerged branch. Its commits may only
                      remain in the reflog.
                    </label>
                  ) : null}
                </>
              ) : editor?.type === "deleteRemote" ? (
                <p className="text-sm">
                  Delete <span className="font-mono">{editor.branch.name}</span>{" "}
                  for every collaborator using this remote.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !editor ||
                  (editor.type === "create" && !editor.name.trim()) ||
                  (editor.type === "rename" && !editor.value.trim()) ||
                  (editor.type === "publish" && !editor.remote) ||
                  (editor.type === "deleteLocal" &&
                    !editor.branch.mergedIntoHead &&
                    !editor.force)
                }
                className={
                  editor?.type.startsWith("delete")
                    ? "bg-destructive text-white hover:bg-destructive/90"
                    : undefined
                }
              >
                Review action
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(reviewedAction)}
        onOpenChange={(open) =>
          !open && !apply.isPending && setReviewedAction(null)
        }
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Confirm branch action</DialogTitle>
            <DialogDescription>
              {reviewedAction
                ? branchActionDescription(reviewedAction)
                : "Review this action."}
            </DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <div className="grid h-32 place-items-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="text-sm text-destructive">
              {preview.error instanceof Error
                ? preview.error.message
                : "Branch preview failed."}
            </p>
          ) : preview.data ? (
            <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs">
              <p className="font-medium">{preview.data.summary}</p>
              {preview.data.branch ? (
                <p className="break-all font-mono text-muted-foreground">
                  {preview.data.branch.fullRef} @ {preview.data.branch.hash}
                </p>
              ) : null}
              {preview.data.warnings.map((warning) => (
                <p key={warning} className="text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
          {apply.error ? (
            <p className="text-sm text-destructive">
              {apply.error instanceof Error
                ? apply.error.message
                : "Branch action failed."}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => setReviewedAction(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!preview.data || apply.isPending}
              className={
                preview.data?.destructive
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
