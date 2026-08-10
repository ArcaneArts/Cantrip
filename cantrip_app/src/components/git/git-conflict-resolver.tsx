import type {
  GitConflictDetail,
  GitConflictResolutionRequest,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileDiff, Loader2, Trash2 } from "lucide-react";
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
  applyProjectWorktreeGitConflictResolution,
  getProjectWorktreeGitConflict,
  getProjectWorktreeGitConflicts,
  previewProjectWorktreeGitConflictResolution,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ConflictMarkerSection {
  start: number;
  end: number;
  ours: string;
  theirs: string;
}

export function parseConflictMarkerSections(
  content: string,
): ConflictMarkerSection[] {
  const lines = content.match(/.*(?:\n|$)/gu) ?? [];
  const sections: ConflictMarkerSection[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("<<<<<<<")) {
      offset += line.length;
      continue;
    }
    const start = offset;
    let separator = -1;
    let end = -1;
    let baseSeparator = -1;
    let scanOffset = offset + line.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const cursorLine = lines[cursor]!;
      if (cursorLine.startsWith("|||||||") && separator < 0) {
        baseSeparator = cursor;
      } else if (cursorLine.startsWith("=======") && separator < 0) {
        separator = cursor;
      } else if (cursorLine.startsWith(">>>>>>>") && separator >= 0) {
        end = cursor;
        const oursStart = index + 1;
        const oursEnd = baseSeparator >= 0 ? baseSeparator : separator;
        sections.push({
          start,
          end: scanOffset + cursorLine.length,
          ours: lines.slice(oursStart, oursEnd).join(""),
          theirs: lines.slice(separator + 1, cursor).join(""),
        });
        index = cursor;
        offset = scanOffset + cursorLine.length;
        break;
      }
      scanOffset += cursorLine.length;
    }
    if (end < 0) offset += line.length;
  }
  return sections;
}

export function resolveConflictMarkerSection(
  content: string,
  section: ConflictMarkerSection,
  strategy: "ours" | "theirs" | "both",
): string {
  const replacement =
    strategy === "ours"
      ? section.ours
      : strategy === "theirs"
        ? section.theirs
        : `${section.ours}${section.ours.endsWith("\n") || !section.ours || !section.theirs ? "" : "\n"}${section.theirs}`;
  return `${content.slice(0, section.start)}${replacement}${content.slice(section.end)}`;
}

function ConflictText({
  binary,
  content,
  label,
  truncated,
}: {
  binary: boolean;
  content: string | null;
  label: string;
  truncated: boolean;
}) {
  if (binary) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {label} is binary and cannot be rendered as text.
      </div>
    );
  }
  if (truncated) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {label} exceeds the 2 MB conflict-view limit.
      </div>
    );
  }
  return (
    <pre className="h-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
      {content ?? `${label} does not exist.`}
    </pre>
  );
}

function detailView(
  detail: GitConflictDetail,
  view: "result" | "ours" | "theirs" | "base",
) {
  if (view === "result") return detail.result;
  return detail[view];
}

export function GitConflictResolver({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<"result" | "ours" | "theirs" | "base">(
    "result",
  );
  const [draft, setDraft] = useState("");
  const [reviewed, setReviewed] = useState<GitConflictResolutionRequest | null>(
    null,
  );
  const conflicts = useQuery({
    queryKey: ["git-conflicts", projectId, worktreeId],
    queryFn: () => getProjectWorktreeGitConflicts(projectId, worktreeId),
    refetchInterval: 2_000,
  });
  useEffect(() => {
    const files = conflicts.data?.files ?? [];
    if (!selectedPath || !files.some(({ path }) => path === selectedPath)) {
      setSelectedPath(files[0]?.path ?? null);
    }
  }, [conflicts.data, selectedPath]);
  const detail = useQuery({
    queryKey: ["git-conflict", projectId, worktreeId, selectedPath],
    queryFn: () =>
      getProjectWorktreeGitConflict(projectId, worktreeId, selectedPath!),
    enabled: Boolean(selectedPath),
  });
  useEffect(() => {
    setDraft(detail.data?.result.content ?? "");
    setView("result");
  }, [detail.data]);
  const preview = useMutation({
    mutationFn: (request: GitConflictResolutionRequest) =>
      previewProjectWorktreeGitConflictResolution(
        projectId,
        worktreeId,
        request,
      ),
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!reviewed || !preview.data) {
        throw new Error("Review the conflict resolution first.");
      }
      return applyProjectWorktreeGitConflictResolution(
        projectId,
        worktreeId,
        reviewed,
        preview.data.token,
      );
    },
    onSuccess: (result) => {
      setReviewed(null);
      preview.reset();
      setSelectedPath(result.remainingPaths[0] ?? null);
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["git-conflicts", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-conflict", projectId, worktreeId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["git-operation", projectId, worktreeId],
      });
    },
  });
  const review = (request: GitConflictResolutionRequest) => {
    setReviewed(request);
    preview.reset();
    apply.reset();
    preview.mutate(request);
  };
  const sections = useMemo(() => parseConflictMarkerSections(draft), [draft]);
  const selectedView = detail.data ? detailView(detail.data, view) : null;

  if (conflicts.isLoading) {
    return <Loader2 className="mx-auto size-4 animate-spin" />;
  }
  if (conflicts.error) {
    return (
      <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        {conflicts.error instanceof Error
          ? conflicts.error.message
          : "Conflicts could not be loaded."}
      </p>
    );
  }
  if (!conflicts.data?.files.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
        <Check className="size-4" /> Git reports no unmerged index entries.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex h-10 items-center gap-2 border-b px-3">
        <AlertTriangle className="size-4 text-amber-500" />
        <p className="text-sm font-medium">
          Resolve {conflicts.data.files.length} conflicted path
          {conflicts.data.files.length === 1 ? "" : "s"}
        </p>
        {conflicts.data.truncated ? (
          <span className="text-[10px] text-muted-foreground">
            First 1,000 shown
          </span>
        ) : null}
      </div>
      <div className="grid min-h-[28rem] grid-cols-[13rem_minmax(0,1fr)]">
        <div className="overflow-auto border-r p-1">
          {conflicts.data.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                selectedPath === file.path
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              onClick={() => setSelectedPath(file.path)}
            >
              <FileDiff className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="font-mono text-[9px]">{file.code}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          {detail.isLoading ? (
            <div className="grid flex-1 place-items-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : detail.error ? (
            <p className="m-3 rounded bg-destructive/10 p-3 text-sm text-destructive">
              {detail.error instanceof Error
                ? detail.error.message
                : "Conflict detail could not be loaded."}
            </p>
          ) : detail.data ? (
            <>
              <div className="flex flex-wrap items-center gap-1 border-b p-2">
                {(["result", "ours", "theirs", "base"] as const).map(
                  (option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={view === option ? "default" : "ghost"}
                      className="h-7 capitalize"
                      onClick={() => setView(option)}
                    >
                      {option}
                    </Button>
                  ),
                )}
                <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                  {detail.data.kind} · {detail.data.path}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                {view === "result" && !detail.data.result.binary ? (
                  <textarea
                    aria-label="Conflict result"
                    className="h-full min-h-72 w-full resize-none bg-transparent p-3 font-mono text-xs outline-none"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : selectedView ? (
                  <ConflictText
                    binary={selectedView.binary}
                    content={selectedView.content}
                    label={view}
                    truncated={selectedView.truncated}
                  />
                ) : null}
              </div>
              {view === "result" && sections.length ? (
                <div className="max-h-36 overflow-auto border-t p-2">
                  <p className="mb-1 text-[10px] font-medium text-muted-foreground">
                    Conflict blocks · choices update the editable result
                  </p>
                  {sections.map((section, index) => (
                    <div
                      key={`${section.start}:${section.end}`}
                      className="flex items-center gap-1 py-1 text-xs"
                    >
                      <span className="mr-auto">Block {index + 1}</span>
                      {(["ours", "theirs", "both"] as const).map((strategy) => (
                        <Button
                          key={strategy}
                          size="sm"
                          variant="outline"
                          className="h-6 capitalize"
                          onClick={() =>
                            setDraft((current) => {
                              const currentSection =
                                parseConflictMarkerSections(current)[index];
                              return currentSection
                                ? resolveConflictMarkerSection(
                                    current,
                                    currentSection,
                                    strategy,
                                  )
                                : current;
                            })
                          }
                        >
                          {strategy}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-1 border-t p-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "ours",
                      content: null,
                    })
                  }
                >
                  Accept ours
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "theirs",
                      content: null,
                    })
                  }
                >
                  Accept theirs
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !detail.data.ours.available ||
                    !detail.data.theirs.available ||
                    detail.data.ours.binary ||
                    detail.data.theirs.binary ||
                    detail.data.ours.truncated ||
                    detail.data.theirs.truncated
                  }
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "both",
                      content: null,
                    })
                  }
                >
                  Accept both
                </Button>
                <Button
                  size="sm"
                  disabled={
                    detail.data.result.binary || detail.data.result.truncated
                  }
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "manual",
                      content: draft,
                    })
                  }
                >
                  Review edited result
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!detail.data.result.exists}
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "result",
                      content: null,
                    })
                  }
                >
                  Stage current result
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  onClick={() =>
                    review({
                      path: detail.data.path,
                      strategy: "delete",
                      content: null,
                    })
                  }
                >
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => {
          if (!open && !apply.isPending) setReviewed(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review conflict resolution</DialogTitle>
            <DialogDescription>
              Cantrip rechecks the unmerged index before applying this exact
              result, then verifies that Git no longer reports the path as
              conflicted.
            </DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <Loader2 className="mx-auto my-16 size-5 animate-spin" />
          ) : preview.error ? (
            <p className="rounded bg-destructive/10 p-3 text-sm text-destructive">
              {preview.error instanceof Error
                ? preview.error.message
                : "Conflict resolution preview failed."}
            </p>
          ) : preview.data ? (
            <div className="space-y-3">
              <p className="text-sm">
                <span className="font-medium capitalize">
                  {preview.data.request.strategy}
                </span>{" "}
                · <span className="font-mono">{preview.data.request.path}</span>
              </p>
              {preview.data.warnings.map((warning) => (
                <p key={warning} className="text-xs text-amber-600">
                  {warning}
                </p>
              ))}
              <pre className="max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
                {preview.data.resultDeleted
                  ? "Path will be deleted."
                  : preview.data.resultBinary
                    ? "Binary result selected."
                    : (preview.data.resultContent ?? "")}
              </pre>
            </div>
          ) : null}
          {apply.error ? (
            <p className="text-sm text-destructive">
              {apply.error instanceof Error
                ? apply.error.message
                : "Conflict resolution failed."}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => setReviewed(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!preview.data || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Apply and stage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
