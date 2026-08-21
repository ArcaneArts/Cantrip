import type { GitLfsAction, GitLfsFile, GitLfsStatus } from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CloudDownload,
  Database,
  Download,
  Loader2,
  Lock,
  PackageCheck,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  applyProjectWorktreeGitLfsAction,
  getProjectWorktreeGitLfs,
  previewProjectWorktreeGitLfsAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  ReviewedOperationDialog,
  useReviewedOperation,
} from "./reviewed-operation";

type View = "files" | "patterns" | "locks";

export function lfsAvailabilityLabel(status: GitLfsStatus): string {
  if (!status.available) return "unavailable";
  if (status.missingObjects) return `${status.missingObjects} missing`;
  if (status.pendingPaths.length) {
    return `${status.pendingPaths.length} pending`;
  }
  return "ready";
}

export function lfsFileStateLabel(file: GitLfsFile): string {
  if (!file.downloaded) return "object missing";
  if (file.status) return `working tree ${file.status}`;
  return file.checkedOut ? "materialized" : "pointer only";
}

export function GitLfsPanel({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("files");
  const [trackPattern, setTrackPattern] = useState<string | null>(null);
  const queryKey = ["worktree-lfs", projectId, worktreeId] as const;
  const lfs = useQuery({
    queryKey,
    queryFn: () => getProjectWorktreeGitLfs(projectId, worktreeId),
  });
  const operation = useReviewedOperation({
    preview: (action: GitLfsAction) =>
      previewProjectWorktreeGitLfsAction(projectId, worktreeId, action),
    apply: ({ preview }) =>
      applyProjectWorktreeGitLfsAction(
        projectId,
        worktreeId,
        preview.action,
        preview.token,
      ),
    missingReviewMessage: "Review a Git LFS action first.",
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.lfs);
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
    },
  });
  const submitTrack = (event: FormEvent) => {
    event.preventDefault();
    const pattern = trackPattern?.trim();
    if (!pattern) return;
    setTrackPattern(null);
    operation.review({ type: "track", pattern });
  };
  const busy = operation.busy;

  if (lfs.isLoading) {
    return <ContentLoading label="Loading Git LFS…" />;
  }
  if (lfs.error) {
    return (
      <InlineAlert
        className="m-4"
        tone="error"
        error={lfs.error}
        fallback="Git LFS request failed."
      />
    );
  }
  const status = lfs.data;
  if (!status?.available) {
    return (
      <ContentEmpty
        className="min-h-64"
        icon={<Database className="size-6 text-muted-foreground" />}
        title="Git LFS is unavailable"
        description={
          status?.message ??
          "Install git-lfs on this worker to inspect and manage large-file objects."
        }
      />
    );
  }

  return (
    <>
      <div className="flex min-h-10 flex-wrap items-center gap-1 border-b px-3 py-1">
        <span className="mr-2 text-[10px] text-muted-foreground">
          {status.version} · {lfsAvailabilityLabel(status)}
        </span>
        <span className="flex-1" />
        <ActionButton
          disabled={busy}
          icon={<PackageCheck className="size-3" />}
          label="Install"
          onClick={() => operation.review({ type: "install" })}
        />
        <ActionButton
          disabled={busy}
          icon={<Download className="size-3" />}
          label="Fetch"
          onClick={() =>
            operation.review({ type: "fetch", remote: null, all: false })
          }
        />
        <ActionButton
          disabled={busy}
          icon={<CloudDownload className="size-3" />}
          label="Pull"
          onClick={() => operation.review({ type: "pull", remote: null })}
        />
        <ActionButton
          disabled={busy}
          icon={<Trash2 className="size-3" />}
          label="Prune…"
          onClick={() =>
            operation.review({ type: "prune", verifyRemote: true })
          }
        />
      </div>
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <div className="flex rounded-md bg-muted/50 p-px">
          {(["files", "patterns", "locks"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={cn(
                "h-6 rounded px-2.5 text-[10px] capitalize text-muted-foreground",
                candidate === view &&
                  "bg-background font-medium text-foreground shadow-sm",
              )}
              onClick={() => setView(candidate)}
            >
              {candidate}
              {candidate === "files" && status.files.length
                ? ` ${status.files.length}`
                : candidate === "patterns" && status.patterns.length
                  ? ` ${status.patterns.length}`
                  : candidate === "locks" && status.locks.length
                    ? ` ${status.locks.length}`
                    : ""}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {view === "files" ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            disabled={busy}
            onClick={() =>
              operation.review({ type: "fetch", remote: null, all: true })
            }
          >
            Fetch all…
          </Button>
        ) : view === "patterns" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[10px]"
            disabled={busy}
            onClick={() => setTrackPattern("")}
          >
            <Plus className="size-3" /> Pattern
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[10px]"
            disabled={busy}
            onClick={() => operation.review({ type: "refreshLocks" })}
          >
            <RefreshCw className="size-3" /> Refresh remote
          </Button>
        )}
      </div>

      {view === "files" ? (
        status.files.length ? (
          status.files.map((file) => {
            const lock = status.locks.find(({ path }) => path === file.path);
            return (
              <div
                key={`${file.path}:${file.oid}`}
                data-high-contrast-row
                className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{file.path}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {lfsFileStateLabel(file)} · {formatBytes(file.size)} ·{" "}
                    {file.oid.slice(0, 10)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() =>
                    operation.review(
                      lock
                        ? { type: "unlock", path: file.path, force: false }
                        : { type: "lock", path: file.path },
                    )
                  }
                >
                  {lock ? (
                    <Unlock className="size-3" />
                  ) : (
                    <Lock className="size-3" />
                  )}
                  {lock ? "Unlock…" : "Lock…"}
                </Button>
              </div>
            );
          })
        ) : (
          <ContentEmpty description="No LFS pointer files are reachable in this repository." />
        )
      ) : view === "patterns" ? (
        status.patterns.length ? (
          status.patterns.map((pattern) => (
            <div
              key={`${pattern.source}:${pattern.pattern}`}
              data-high-contrast-row
              className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{pattern.pattern}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {pattern.source}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-destructive"
                disabled={busy}
                onClick={() =>
                  operation.review({
                    type: "untrack",
                    pattern: pattern.pattern,
                  })
                }
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))
        ) : (
          <ContentEmpty description="No Git LFS patterns are configured." />
        )
      ) : status.locks.length ? (
        status.locks.map((lock) => (
          <div
            key={lock.id}
            data-high-contrast-row
            className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{lock.path}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {lock.owner ?? "Unknown owner"}
                {lock.ours ? " · yours" : ""}
                {lock.lockedAt
                  ? ` · ${new Date(lock.lockedAt).toLocaleString()}`
                  : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[10px]"
              disabled={busy}
              onClick={() =>
                operation.review({
                  type: "unlock",
                  path: lock.path,
                  force: !lock.ours,
                })
              }
            >
              <Unlock className="size-3" />
              {lock.ours ? "Unlock…" : "Force unlock…"}
            </Button>
          </div>
        ))
      ) : (
        <ContentEmpty
          description={
            status.lockError
              ? `Locks unavailable: ${status.lockError}`
              : `No ${status.locksCached ? "cached " : ""}LFS locks.`
          }
        />
      )}

      <Dialog
        open={trackPattern !== null}
        onOpenChange={(open) => !open && setTrackPattern(null)}
      >
        <DialogContent>
          <form onSubmit={submitTrack}>
            <DialogHeader>
              <DialogTitle>Track with Git LFS</DialogTitle>
              <DialogDescription>
                Add a pattern to .gitattributes in the selected worktree.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              className="my-4"
              placeholder="For example, *.psd or assets/**"
              value={trackPattern ?? ""}
              onChange={(event) => setTrackPattern(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTrackPattern(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!trackPattern?.trim()}>
                Review
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ReviewedOperationDialog
        operation={operation}
        title="Review Git LFS action"
        description="The assigned worker recomputes LFS and worktree state before applying this action."
        loadingLabel="Inspecting Git LFS…"
        loadingClassName="justify-start"
        bodyClassName="grid gap-3 py-3 text-sm"
        previewErrorFallback="Git LFS preview failed."
        applyErrorFallback="Git LFS action failed."
        applyLabel="Apply"
        applyVariant={
          operation.preview.data?.destructive ? "destructive" : "default"
        }
      >
        {(preview) => (
          <>
            <p>{preview.summary}</p>
            {preview.warnings.map((warning) => (
              <p key={warning} className="text-xs text-amber-600">
                {warning}
              </p>
            ))}
          </>
        )}
      </ReviewedOperationDialog>
    </>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1 px-2 text-[10px]"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
