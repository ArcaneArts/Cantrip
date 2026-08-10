import type {
  GitFileDiff,
  GitPartialPatchOperation,
  GitPartialPatchRequest,
} from "@cantrip/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckSquare2, Loader2, Square, X } from "lucide-react";
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
  applyProjectWorktreePartialPatch,
  previewProjectWorktreePartialPatch,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";

export interface SelectablePatchLine {
  index: number;
  kind: "add" | "delete" | "context" | "meta";
  text: string;
}

export interface SelectablePatchHunk {
  index: number;
  header: string;
  lines: SelectablePatchLine[];
}

export function parseSelectablePatchHunks(
  patch: string,
): SelectablePatchHunk[] {
  const hunks: SelectablePatchHunk[] = [];
  let current: SelectablePatchHunk | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      current = { index: hunks.length, header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const prefix = line[0];
    current.lines.push({
      index: current.lines.length,
      kind:
        prefix === "+"
          ? "add"
          : prefix === "-"
            ? "delete"
            : prefix === " "
              ? "context"
              : "meta",
      text: line,
    });
  }
  return hunks;
}

export function buildPartialPatchRequest(
  operation: GitPartialPatchOperation,
  path: string,
  hunks: SelectablePatchHunk[],
  selected: ReadonlySet<string>,
): GitPartialPatchRequest | null {
  const selections = hunks.flatMap((hunk) => {
    const changed = hunk.lines.filter(
      ({ kind }) => kind === "add" || kind === "delete",
    );
    const lineIndexes = changed
      .filter(({ index }) => selected.has(`${hunk.index}:${index}`))
      .map(({ index }) => index);
    if (lineIndexes.length === 0) return [];
    return [
      {
        hunkIndex: hunk.index,
        lineIndexes: lineIndexes.length === changed.length ? null : lineIndexes,
      },
    ];
  });
  return selections.length ? { operation, path, hunks: selections } : null;
}

export function partialPatchUnavailableReason(
  diff: Pick<GitFileDiff, "patch" | "truncated"> | undefined,
): string | null {
  if (!diff) return null;
  if (diff.truncated) {
    return "Truncated patches cannot be applied partially. Use the file-level action.";
  }
  if (
    diff.patch
      .split("\n")
      .some(
        (line) =>
          line.startsWith("rename from ") ||
          line.startsWith("rename to ") ||
          line.startsWith("old mode ") ||
          line.startsWith("new mode "),
      )
  ) {
    return "Renames and mode changes must use the file-level action so repository metadata stays consistent.";
  }
  return null;
}

export function GitPartialPatchView({
  diff,
  error,
  loading,
  onClose,
  path,
  projectId,
  scope,
  worktreeId,
}: {
  diff: GitFileDiff | undefined;
  error: unknown;
  loading: boolean;
  onClose(): void;
  path: string;
  projectId: string;
  scope: "unstaged" | "staged";
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const hunks = useMemo(
    () => parseSelectablePatchHunks(diff?.patch ?? ""),
    [diff],
  );
  const unavailableReason = partialPatchUnavailableReason(diff);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [reviewedRequest, setReviewedRequest] =
    useState<GitPartialPatchRequest | null>(null);
  useEffect(() => setSelected(new Set()), [diff?.patch]);
  const preview = useMutation({
    mutationFn: (input: GitPartialPatchRequest) =>
      previewProjectWorktreePartialPatch(projectId, worktreeId, input),
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!reviewedRequest || !preview.data)
        throw new Error("Review a patch first.");
      return applyProjectWorktreePartialPatch(
        projectId,
        worktreeId,
        reviewedRequest,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-file-diff", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      setReviewedRequest(null);
      setSelected(new Set());
    },
  });
  const changedLineCount = hunks.reduce(
    (count, hunk) =>
      count +
      hunk.lines.filter(
        (line) =>
          (line.kind === "add" || line.kind === "delete") &&
          selected.has(`${hunk.index}:${line.index}`),
      ).length,
    0,
  );
  const toggleHunk = (hunk: SelectablePatchHunk) => {
    const keys = hunk.lines
      .filter(({ kind }) => kind === "add" || kind === "delete")
      .map(({ index }) => `${hunk.index}:${index}`);
    const all = keys.length > 0 && keys.every((key) => selected.has(key));
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) all ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const begin = (nextOperation: GitPartialPatchOperation) => {
    const nextRequest = buildPartialPatchRequest(
      nextOperation,
      path,
      hunks,
      selected,
    );
    if (!nextRequest) return;
    setReviewedRequest(nextRequest);
    preview.reset();
    apply.reset();
    preview.mutate(nextRequest);
  };

  const operation = reviewedRequest?.operation ?? null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          size="icon"
          variant="ghost"
          className="size-8 md:hidden"
          onClick={onClose}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium">{path}</p>
          <p className="text-[10px] text-muted-foreground">
            Select changed lines or whole hunks · {scope}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="hidden size-8 md:inline-flex"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {loading ? (
        <div className="grid flex-1 place-items-center">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="grid flex-1 place-items-center p-6 text-sm text-destructive">
          {error instanceof Error ? error.message : "Diff could not be loaded."}
        </div>
      ) : unavailableReason ? (
        <div className="grid flex-1 place-items-center p-6 text-sm text-amber-600">
          {unavailableReason}
        </div>
      ) : hunks.length === 0 ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
          This binary, rename-only, or mode-only change has no selectable text
          hunks. Use the file-level action.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5">
          {hunks.map((hunk) => {
            const changed = hunk.lines.filter(
              ({ kind }) => kind === "add" || kind === "delete",
            );
            const all =
              changed.length > 0 &&
              changed.every(({ index }) =>
                selected.has(`${hunk.index}:${index}`),
              );
            return (
              <div
                key={hunk.index}
                className="mb-3 overflow-hidden rounded-lg bg-muted/20"
              >
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 bg-blue-500/10 px-2 text-left text-blue-700 dark:text-blue-300"
                  onClick={() => toggleHunk(hunk)}
                >
                  {all ? (
                    <CheckSquare2 className="size-3.5" />
                  ) : (
                    <Square className="size-3.5" />
                  )}
                  <span className="truncate">{hunk.header}</span>
                </button>
                {hunk.lines.map((line) => {
                  const selectable =
                    line.kind === "add" || line.kind === "delete";
                  const key = `${hunk.index}:${line.index}`;
                  return (
                    <button
                      key={line.index}
                      type="button"
                      disabled={!selectable}
                      className={cn(
                        "flex min-h-5 w-full items-start gap-2 px-2 text-left whitespace-pre",
                        line.kind === "add" && "bg-emerald-500/10",
                        line.kind === "delete" && "bg-red-500/10",
                        selectable && "hover:brightness-110",
                      )}
                      onClick={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          next.has(key) ? next.delete(key) : next.add(key);
                          return next;
                        })
                      }
                    >
                      <span className="mt-0.5 w-3 shrink-0">
                        {selectable ? (
                          selected.has(key) ? (
                            <CheckSquare2 className="size-3" />
                          ) : (
                            <Square className="size-3" />
                          )
                        ) : null}
                      </span>
                      <span>{line.text || " "}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t p-2">
        <span className="mr-auto text-[10px] text-muted-foreground">
          {changedLineCount} changed lines selected
        </span>
        {scope === "unstaged" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!changedLineCount || Boolean(unavailableReason)}
            onClick={() => begin("discard")}
          >
            Discard…
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!changedLineCount || Boolean(unavailableReason)}
          onClick={() => begin(scope === "staged" ? "unstage" : "stage")}
        >
          {scope === "staged" ? "Unstage" : "Stage"}…
        </Button>
      </div>

      <Dialog
        open={reviewedRequest !== null}
        onOpenChange={(open) =>
          !open && !apply.isPending && setReviewedRequest(null)
        }
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="capitalize">
              {operation} selected changes?
            </DialogTitle>
            <DialogDescription>
              Review the exact patch. It will be rejected if the file changes
              before apply.
            </DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <div className="grid h-48 place-items-center">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : preview.error ? (
            <p className="text-sm text-destructive">
              {preview.error instanceof Error
                ? preview.error.message
                : "Patch preview failed."}
            </p>
          ) : preview.data ? (
            <div className="flex h-[55vh] min-h-72 overflow-hidden rounded-lg border">
              <GitPatchView
                error={null}
                loading={false}
                newLabel="Result"
                oldLabel="Before"
                onClose={() => undefined}
                patch={preview.data.patch}
                path={preview.data.path}
                showClose={false}
                subtitle={`${preview.data.selectedHunks} hunk${preview.data.selectedHunks === 1 ? "" : "s"} · ${preview.data.selectedLines} changed line${preview.data.selectedLines === 1 ? "" : "s"}`}
                truncated={false}
              />
            </div>
          ) : null}
          {apply.error ? (
            <p className="text-sm text-destructive">
              {apply.error instanceof Error
                ? apply.error.message
                : "Patch apply failed."}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => setReviewedRequest(null)}
            >
              Cancel
            </Button>
            <Button
              className={
                operation === "discard"
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : undefined
              }
              disabled={!preview.data || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Apply exact patch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
