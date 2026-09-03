import type {
  GitFileDiff,
  GitPartialPatchOperation,
  GitPartialPatchRequest,
} from "@cantrip/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  applyProjectWorktreePartialPatch,
  previewProjectWorktreePartialPatch,
} from "@/lib/api";

import { GitPatchView } from "./git-patch-view";
import {
  ReviewedOperationDialog,
  useReviewedOperation,
} from "./reviewed-operation";

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
  onContextLinesChange,
  onOpenFile,
  path,
  projectId,
  scope,
  worktreeId,
}: {
  diff: GitFileDiff | undefined;
  error: unknown;
  loading: boolean;
  onClose(): void;
  onContextLinesChange?(contextLines: number): void;
  onOpenFile?(): void;
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
  useEffect(() => setSelected(new Set()), [diff?.patch]);
  const reviewedOperation = useReviewedOperation({
    preview: (input: GitPartialPatchRequest) =>
      previewProjectWorktreePartialPatch(projectId, worktreeId, input),
    apply: ({ preview, request }) =>
      applyProjectWorktreePartialPatch(
        projectId,
        worktreeId,
        request,
        preview.token,
      ),
    missingReviewMessage: "Review a patch first.",
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
  const toggleHunk = (hunkIndex: number, lineIndexes: number[]) => {
    const keys = lineIndexes.map((lineIndex) => `${hunkIndex}:${lineIndex}`);
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
    reviewedOperation.review(nextRequest);
  };

  const operation = reviewedOperation.request?.operation ?? null;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <GitPatchView
        binary={diff?.binary}
        error={error}
        lineSelection={
          unavailableReason || hunks.length === 0
            ? undefined
            : {
                selected,
                onToggleHunk: toggleHunk,
                onToggleLine: (hunkIndex, lineIndex) => {
                  const key = `${hunkIndex}:${lineIndex}`;
                  setSelected((current) => {
                    const next = new Set(current);
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  });
                },
              }
        }
        loading={loading}
        newFile={diff?.newFile}
        newLabel={scope === "staged" ? "Index" : "Working tree"}
        oldFile={diff?.oldFile}
        oldLabel={scope === "staged" ? "HEAD" : "Index"}
        onClose={onClose}
        onContextLinesChange={onContextLinesChange}
        onOpenFile={onOpenFile}
        originalPath={diff?.originalPath}
        patch={diff?.patch}
        path={path}
        subtitle={`Select changed lines or whole hunks · ${scope}`}
        truncated={diff?.truncated ?? false}
      />
      {unavailableReason ? (
        <p className="shrink-0 border-t bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
          {unavailableReason}
        </p>
      ) : null}
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

      <ReviewedOperationDialog
        operation={reviewedOperation}
        title={
          <span className="capitalize">{operation} selected changes?</span>
        }
        description="Review the exact patch. It will be rejected if the file changes before apply."
        loadingLabel="Inspecting exact patch…"
        loadingClassName="h-48"
        previewErrorFallback="Patch preview failed."
        applyErrorFallback="Patch apply failed."
        applyLabel="Apply exact patch"
        contentClassName="max-w-3xl"
        bodyClassName="grid gap-3"
        applyVariant={operation === "discard" ? "destructive" : "default"}
      >
        {(preview) => (
          <div className="flex h-[55vh] min-h-72 overflow-hidden rounded-lg border">
            <GitPatchView
              error={null}
              loading={false}
              newLabel="Result"
              oldLabel="Before"
              onClose={() => undefined}
              patch={preview.patch}
              path={preview.path}
              showClose={false}
              subtitle={`${preview.selectedHunks} hunk${preview.selectedHunks === 1 ? "" : "s"} · ${preview.selectedLines} changed line${preview.selectedLines === 1 ? "" : "s"}`}
              truncated={false}
            />
          </div>
        )}
      </ReviewedOperationDialog>
    </section>
  );
}
