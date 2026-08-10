import type {
  GitSubmoduleAction,
  GitSubmoduleSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Unplug,
} from "lucide-react";
import type { ReactNode } from "react";

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
  applyProjectWorktreeSubmoduleAction,
  getProjectWorktreeSubmodules,
  previewProjectWorktreeSubmoduleAction,
} from "@/lib/api";

export function submoduleStateLabel(module: GitSubmoduleSummary): string {
  if (module.dirty) return "local changes";
  switch (module.state) {
    case "clean":
      return "recorded commit";
    case "uninitialized":
      return "not initialized";
    case "changed":
      return "different commit";
    case "conflicted":
      return "conflicted";
    case "missing":
      return "missing checkout";
  }
}

export function GitSubmodulePanel({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["worktree-submodules", projectId, worktreeId] as const;
  const submodules = useQuery({
    queryKey,
    queryFn: () => getProjectWorktreeSubmodules(projectId, worktreeId),
  });
  const preview = useMutation({
    mutationFn: (action: GitSubmoduleAction) =>
      previewProjectWorktreeSubmoduleAction(projectId, worktreeId, action),
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("Review a submodule action first.");
      return applyProjectWorktreeSubmoduleAction(
        projectId,
        worktreeId,
        preview.data.action,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.submodules);
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      preview.reset();
    },
  });
  const review = (action: GitSubmoduleAction) => {
    apply.reset();
    preview.reset();
    preview.mutate(action);
  };
  const busy = preview.isPending || apply.isPending;

  if (submodules.isLoading) {
    return (
      <div className="grid h-48 place-items-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (submodules.error) {
    return (
      <div className="p-4 text-sm text-destructive">
        {submodules.error instanceof Error
          ? submodules.error.message
          : "Submodules could not be loaded."}
      </div>
    );
  }

  const items = submodules.data?.submodules ?? [];
  return (
    <>
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {items.length
            ? `${items.length} configured submodule${items.length === 1 ? "" : "s"}${submodules.data?.truncated ? " · truncated" : ""}`
            : "No configured submodules"}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[10px]"
          disabled={!items.length || busy}
          onClick={() =>
            review({
              type: "sync",
              path: null,
              recursive: true,
            })
          }
        >
          <RefreshCw className="size-3" /> Sync URLs
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-[10px]"
          disabled={!items.length || busy}
          onClick={() =>
            review({
              type: "initialize",
              path: null,
              recursive: true,
            })
          }
        >
          <Boxes className="size-3" /> Initialize all
        </Button>
      </div>
      {items.length ? (
        items.map((module) => (
          <div
            key={module.path}
            data-high-contrast-row
            className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                <Boxes className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{module.path}</span>
                {module.nested ? <Pill>nested</Pill> : null}
                <Pill>{submoduleStateLabel(module)}</Pill>
              </p>
              <p className="truncate text-[10px] text-muted-foreground">
                {module.url}
                {module.branch ? ` · branch ${module.branch}` : ""}
                {module.currentHash
                  ? ` · ${module.currentHash.slice(0, 10)}`
                  : ""}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              {!module.initialized ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() =>
                    review({
                      type: "initialize",
                      path: module.path,
                      recursive: true,
                    })
                  }
                >
                  <Check className="size-3" /> Initialize
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() =>
                      review({
                        type: "update",
                        path: module.path,
                        recursive: true,
                        remote: false,
                      })
                    }
                  >
                    <GitCompareArrows className="size-3" /> Recorded
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() =>
                      review({
                        type: "update",
                        path: module.path,
                        recursive: true,
                        remote: true,
                      })
                    }
                  >
                    Remote…
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-destructive"
                    disabled={busy}
                    title={
                      module.dirty
                        ? "Force deinitialize and discard local changes"
                        : "Deinitialize submodule"
                    }
                    onClick={() =>
                      review({
                        type: "deinitialize",
                        path: module.path,
                        force: module.dirty,
                      })
                    }
                  >
                    <Unplug className="size-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="grid h-48 place-items-center text-center text-sm text-muted-foreground">
          This repository has no .gitmodules configuration.
        </div>
      )}

      <Dialog
        open={
          preview.isPending || Boolean(preview.data) || Boolean(preview.error)
        }
        onOpenChange={(open) => {
          if (!open && !apply.isPending) {
            preview.reset();
            apply.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review submodule action</DialogTitle>
            <DialogDescription>
              This action runs only in the selected worktree on its assigned
              worker.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-3 text-sm">
            {preview.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Inspecting exact
                submodule state…
              </div>
            ) : preview.error ? (
              <p className="text-destructive">
                {preview.error instanceof Error
                  ? preview.error.message
                  : "The action could not be reviewed."}
              </p>
            ) : preview.data ? (
              <>
                <p>{preview.data.summary}</p>
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {preview.data.targets.map((target) => target.path).join(", ")}
                </div>
                {preview.data.warnings.map((warning) => (
                  <p key={warning} className="text-xs text-amber-600">
                    {warning}
                  </p>
                ))}
              </>
            ) : null}
            {apply.error ? (
              <p className="text-sm text-destructive">
                {apply.error instanceof Error
                  ? apply.error.message
                  : "The submodule action failed."}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => {
                preview.reset();
                apply.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              className={
                preview.data?.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              disabled={!preview.data || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-normal text-muted-foreground">
      {children}
    </span>
  );
}
