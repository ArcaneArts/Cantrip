import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  GitStashAction,
  GitStashCreate,
  GitStashList,
  GitStashSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

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
  applyProjectWorktreeStashAction,
  createProjectWorktreeStash,
  getProjectWorktreeStashFileDiff,
  getProjectWorktreeStashes,
  previewProjectWorktreeStashAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";

const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function stashAge(createdAt: string, now = Date.now()): string {
  const seconds = Math.round((new Date(createdAt).getTime() - now) / 1_000);
  if (Math.abs(seconds) < 60) return relativeTime.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}

export function stashActionDescription(action: GitStashAction): string {
  switch (action.type) {
    case "apply":
      return "Apply these changes and keep the stash.";
    case "pop":
      return "Apply these changes and remove the stash only if Git succeeds.";
    case "drop":
      return "Permanently delete this stash without applying it.";
    case "clear":
      return "Permanently delete every listed stash.";
    case "branch":
      return `Create ${action.branch} at the stash base, apply the changes, and remove the stash only if Git succeeds.`;
  }
}

export function prependCreatedStash(
  current: GitStashList | undefined,
  stash: GitStashSummary,
): GitStashList {
  return {
    stashes: [
      stash,
      ...(current?.stashes ?? []).filter(({ hash }) => hash !== stash.hash),
    ],
    truncated: current?.truncated ?? false,
  };
}

function ScopeToggle({
  checked,
  children,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 text-sm",
        disabled && "opacity-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-primary"
      />
      {children}
    </label>
  );
}

function StashActions({
  disabled,
  onAction,
  stash,
}: {
  disabled: boolean;
  onAction(
    type: "apply" | "pop" | "drop" | "branch",
    stash: GitStashSummary,
  ): void;
  stash: GitStashSummary;
}) {
  const itemClass =
    "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
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
          <span className="sr-only">Stash actions</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          className="z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={() => onAction("apply", stash)}
          >
            <ArchiveRestore className="size-3.5" /> Apply
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={() => onAction("pop", stash)}
          >
            <ArchiveRestore className="size-3.5" /> Pop
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={() => onAction("branch", stash)}
          >
            <GitBranch className="size-3.5" /> Create branch
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item
            className={cn(itemClass, "text-destructive focus:text-destructive")}
            onSelect={() => onAction("drop", stash)}
          >
            <Trash2 className="size-3.5" /> Drop
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function GitStashPanel({
  onClose,
  projectId,
  worktreeId,
}: {
  onClose(): void;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [includeStaged, setIncludeStaged] = useState(true);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [reviewedAction, setReviewedAction] = useState<GitStashAction | null>(
    null,
  );
  const [branchStash, setBranchStash] = useState<GitStashSummary | null>(null);
  const [branchName, setBranchName] = useState("");
  const [conflictedPaths, setConflictedPaths] = useState<string[]>([]);
  const stashes = useQuery({
    queryKey: ["worktree-stashes", projectId, worktreeId],
    queryFn: () => getProjectWorktreeStashes(projectId, worktreeId),
  });
  const selected =
    stashes.data?.stashes.find(({ hash }) => hash === selectedHash) ?? null;
  useEffect(() => {
    const first = stashes.data?.stashes[0];
    if (
      !selectedHash ||
      !stashes.data?.stashes.some(({ hash }) => hash === selectedHash)
    ) {
      setSelectedHash(first?.hash ?? null);
      setSelectedPath(first?.files[0]?.path ?? null);
    }
  }, [selectedHash, stashes.data]);
  const diff = useQuery({
    enabled: Boolean(selected && selectedPath),
    queryKey: [
      "worktree-stash-diff",
      projectId,
      worktreeId,
      selectedHash,
      selectedPath,
    ],
    queryFn: () =>
      getProjectWorktreeStashFileDiff(
        projectId,
        worktreeId,
        selectedHash!,
        selectedPath!,
      ),
  });
  const refreshAfterMutation = (status: unknown) => {
    queryClient.setQueryData(
      ["worktree-status", projectId, worktreeId],
      status,
    );
    void queryClient.invalidateQueries({
      queryKey: ["worktree-stashes", projectId, worktreeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["worktree-history", projectId, worktreeId],
    });
  };
  const create = useMutation({
    mutationFn: (input: GitStashCreate) =>
      createProjectWorktreeStash(projectId, worktreeId, input),
    onSuccess: (result) => {
      if (result.stash) {
        queryClient.setQueryData<GitStashList>(
          ["worktree-stashes", projectId, worktreeId],
          (current) => prependCreatedStash(current, result.stash!),
        );
      }
      refreshAfterMutation(result.status);
      setCreateOpen(false);
      setMessage("");
      setSelectedHash(result.stash?.hash ?? null);
      setSelectedPath(result.stash?.files[0]?.path ?? null);
    },
  });
  const preview = useMutation({
    mutationFn: (action: GitStashAction) =>
      previewProjectWorktreeStashAction(projectId, worktreeId, action),
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!reviewedAction || !preview.data)
        throw new Error("Review a stash action first.");
      return applyProjectWorktreeStashAction(
        projectId,
        worktreeId,
        reviewedAction,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      refreshAfterMutation(result.status);
      setConflictedPaths(result.conflictedPaths);
      setReviewedAction(null);
      preview.reset();
    },
  });
  const review = (action: GitStashAction) => {
    setReviewedAction(action);
    preview.reset();
    apply.reset();
    preview.mutate(action);
  };
  const chooseAction = (
    type: "apply" | "pop" | "drop" | "branch",
    stash: GitStashSummary,
  ) => {
    if (type === "branch") {
      setBranchStash(stash);
      setBranchName("");
      return;
    }
    review({ type, ref: stash.ref, hash: stash.hash });
  };
  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    create.mutate({
      message: message.trim(),
      includeStaged,
      includeUnstaged,
      includeUntracked,
    });
  };
  const submitBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!branchStash || !branchName.trim()) return;
    review({
      type: "branch",
      ref: branchStash.ref,
      hash: branchStash.hash,
      branch: branchName.trim(),
    });
    setBranchStash(null);
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background shadow-2xl md:w-[min(78rem,88vw)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Archive className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Stashes</p>
          <p className="text-[10px] text-muted-foreground">
            Saved changes for this worktree repository
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5" /> New stash
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-destructive hover:text-destructive"
          disabled={
            !stashes.data?.stashes.length ||
            preview.isPending ||
            apply.isPending
          }
          onClick={() => review({ type: "clear" })}
        >
          Clear…
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close stashes</span>
        </Button>
      </div>
      {conflictedPaths.length ? (
        <div className="shrink-0 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Stash changes produced conflicts in {conflictedPaths.join(", ")}. The
          stash was kept; resolve these paths in Working changes.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-h-0 shrink-0 overflow-auto border-r md:block md:w-72",
            mobileDetailOpen ? "hidden" : "block w-full",
          )}
        >
          {stashes.isLoading ? (
            <div className="grid h-40 place-items-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : stashes.error ? (
            <p className="p-4 text-xs text-destructive">
              {stashes.error instanceof Error
                ? stashes.error.message
                : "Stashes could not be loaded."}
            </p>
          ) : stashes.data?.stashes.length ? (
            stashes.data.stashes.map((stash) => (
              <div
                key={stash.hash}
                data-high-contrast-row
                className={cn(
                  "flex min-w-0 items-center gap-1 px-2 py-2 hover:bg-muted/50",
                  stash.hash === selectedHash && "bg-muted/70",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  title={`${stash.message}\nCreated ${new Date(stash.createdAt).toLocaleString()}\nBase ${stash.baseHash ?? "unavailable"}`}
                  onClick={() => {
                    setSelectedHash(stash.hash);
                    setSelectedPath(stash.files[0]?.path ?? null);
                    setMobileDetailOpen(true);
                  }}
                >
                  <span className="block truncate text-xs font-medium">
                    {stash.message}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {stash.ref} · {stash.filesChanged} files ·{" "}
                    {stashAge(stash.createdAt)}
                  </span>
                </button>
                <StashActions
                  disabled={preview.isPending || apply.isPending}
                  stash={stash}
                  onAction={chooseAction}
                />
              </div>
            ))
          ) : (
            <div className="grid h-48 place-items-center p-5 text-center text-xs text-muted-foreground">
              No stashes in this repository.
            </div>
          )}
          {stashes.data?.truncated ? (
            <p className="p-3 text-[10px] text-amber-600">
              Only the first bounded stash page is shown. Clear is disabled by
              the worker until the full set can be reviewed.
            </p>
          ) : null}
        </div>
        {selected ? (
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 md:flex",
              mobileDetailOpen ? "flex" : "hidden",
            )}
          >
            <div className="min-h-0 w-56 shrink-0 overflow-auto border-r p-2">
              <Button
                size="sm"
                variant="ghost"
                className="mb-2 h-7 gap-1 text-xs md:hidden"
                onClick={() => setMobileDetailOpen(false)}
              >
                <ArrowLeft className="size-3.5" /> Stashes
              </Button>
              <div className="mb-2 px-2 text-[10px] text-muted-foreground">
                {selected.additions} additions · {selected.deletions} deletions
                {selected.includesUntracked ? " · includes untracked" : ""}
                {selected.baseHash
                  ? ` · base ${selected.baseHash.slice(0, 10)}`
                  : ""}
              </div>
              {selected.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  data-high-contrast-row
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-muted/50",
                    file.path === selectedPath && "bg-muted/70",
                  )}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {file.path}
                  </span>
                  {file.binary ? (
                    <span className="text-[9px] text-muted-foreground">
                      binary
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {selectedPath ? (
              <GitPatchView
                error={diff.error}
                loading={diff.isLoading}
                newLabel="Stashed"
                oldLabel="Base"
                onClose={() => setSelectedPath(null)}
                patch={diff.data?.patch}
                path={selectedPath}
                showClose={false}
                subtitle={`${selected.message} · ${selected.shortHash}`}
                truncated={diff.data?.truncated ?? false}
              />
            ) : (
              <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
                Choose a changed file.
              </div>
            )}
          </div>
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            Choose a stash.
          </div>
        )}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => !create.isPending && setCreateOpen(open)}
      >
        <DialogContent>
          <form onSubmit={submitCreate}>
            <DialogHeader>
              <DialogTitle>Create stash</DialogTitle>
              <DialogDescription>
                Save selected scopes without changing another worktree.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <Input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Stash name"
                autoFocus
              />
              <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                <ScopeToggle
                  checked={includeStaged}
                  onChange={(checked) => {
                    setIncludeStaged(checked);
                    if (checked && !includeUnstaged) setIncludeUntracked(false);
                  }}
                >
                  Staged changes
                </ScopeToggle>
                <ScopeToggle
                  checked={includeUnstaged}
                  onChange={(checked) => {
                    setIncludeUnstaged(checked);
                    if (!checked && includeStaged) setIncludeUntracked(false);
                  }}
                >
                  Unstaged changes
                </ScopeToggle>
                <ScopeToggle
                  checked={includeUntracked}
                  disabled={includeStaged && !includeUnstaged}
                  onChange={setIncludeUntracked}
                >
                  Untracked files
                </ScopeToggle>
                {includeStaged && !includeUnstaged ? (
                  <p className="text-[10px] text-muted-foreground">
                    Git cannot combine staged-only and untracked scopes.
                  </p>
                ) : null}
              </div>
              {create.error ? (
                <p className="text-xs text-destructive">
                  {create.error instanceof Error
                    ? create.error.message
                    : "Stash creation failed."}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  !message.trim() ||
                  (!includeStaged && !includeUnstaged && !includeUntracked)
                }
              >
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}{" "}
                Create stash
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(branchStash)}
        onOpenChange={(open) => !open && setBranchStash(null)}
      >
        <DialogContent>
          <form onSubmit={submitBranch}>
            <DialogHeader>
              <DialogTitle>Create branch from stash</DialogTitle>
              <DialogDescription>
                The branch starts at the stash base commit before applying its
                changes.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="branch/name"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBranchStash(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!branchName.trim()}>
                Review branch
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="capitalize">
              {reviewedAction?.type} stash changes?
            </DialogTitle>
            <DialogDescription>
              {reviewedAction
                ? stashActionDescription(reviewedAction)
                : "Review this action."}
            </DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <div className="grid h-36 place-items-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="text-xs text-destructive">
              {preview.error instanceof Error
                ? preview.error.message
                : "Preview failed."}
            </p>
          ) : preview.data ? (
            <div className="max-h-[50vh] overflow-auto rounded-lg bg-muted/30 p-3 text-xs">
              {preview.data.warnings.map((warning) => (
                <p
                  key={warning}
                  className="mb-2 text-amber-700 dark:text-amber-300"
                >
                  {warning}
                </p>
              ))}
              {preview.data.stashes.map((stash) => (
                <div key={stash.hash} className="mb-2 last:mb-0">
                  <p className="font-medium">
                    {stash.ref} · {stash.message}
                  </p>
                  <p className="text-muted-foreground">
                    {stash.filesChanged} files, +{stash.additions} −
                    {stash.deletions} · {stash.hash}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
          {apply.error ? (
            <p className="text-xs text-destructive">
              {apply.error instanceof Error
                ? apply.error.message
                : "Stash action failed."}
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
                preview.data?.destructive &&
                reviewedAction?.type !== "pop" &&
                reviewedAction?.type !== "branch"
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}{" "}
              Confirm {reviewedAction?.type}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
