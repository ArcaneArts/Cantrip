import type {
  GitSubmoduleAction,
  GitSubmoduleSummary,
} from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  ReviewedOperationDialog,
  useReviewedOperation,
} from "./reviewed-operation";
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
  const operation = useReviewedOperation({
    preview: (action: GitSubmoduleAction) =>
      previewProjectWorktreeSubmoduleAction(projectId, worktreeId, action),
    apply: ({ preview }) =>
      applyProjectWorktreeSubmoduleAction(
        projectId,
        worktreeId,
        preview.action,
        preview.token,
      ),
    missingReviewMessage: "Review a submodule action first.",
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.submodules);
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
    },
  });
  const busy = operation.busy;

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
            operation.review({
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
            operation.review({
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
                    operation.review({
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
                      operation.review({
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
                      operation.review({
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
                      operation.review({
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

      <ReviewedOperationDialog
        operation={operation}
        title="Review submodule action"
        description="This action runs only in the selected worktree on its assigned worker."
        loadingLabel="Inspecting exact submodule state…"
        loadingClassName="justify-start"
        bodyClassName="grid gap-3 py-3 text-sm"
        previewErrorFallback="The action could not be reviewed."
        applyErrorFallback="The submodule action failed."
        applyLabel="Apply"
        applyVariant={
          operation.preview.data?.destructive ? "destructive" : "default"
        }
      >
        {(preview) => (
          <>
            <p>{preview.summary}</p>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {preview.targets.map((target) => target.path).join(", ")}
            </div>
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

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-normal text-muted-foreground">
      {children}
    </span>
  );
}
