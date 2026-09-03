import type { GitFileHistory } from "@cantrip/protocol";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { FileClock, GitCommitHorizontal, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ContentEmpty, ContentLoading } from "@/components/ui/content-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  getProjectWorktreeFileBlame,
  getProjectWorktreeFileHistory,
  getProjectWorktreeRevisionDiff,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";

type FileToolTab = "history" | "blame" | "compare";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function flattenFileHistoryPages(pages: GitFileHistory[] | undefined) {
  return pages?.flatMap(({ commits }) => commits) ?? [];
}

export function GitFileHistoryDialog({
  onOpenChange,
  onOpenCommit,
  onOpenFile,
  open,
  projectId,
  worktreeId,
}: {
  onOpenChange(open: boolean): void;
  onOpenCommit(revision: string): void;
  onOpenFile?(path: string): void;
  open: boolean;
  projectId: string;
  worktreeId: string;
}) {
  const [tab, setTab] = useState<FileToolTab>("history");
  const [diffContextLines, setDiffContextLines] = useState(3);
  const [path, setPath] = useState("");
  const [revision, setRevision] = useState("HEAD");
  const [selection, setSelection] = useState<{
    path: string;
    revision: string;
  } | null>(null);
  const [left, setLeft] = useState("HEAD~1");
  const [right, setRight] = useState("HEAD");
  const history = useInfiniteQuery({
    enabled: open && Boolean(selection) && tab === "history",
    initialPageParam: 0,
    queryKey: ["git-file-history", projectId, worktreeId, selection],
    queryFn: ({ pageParam }) =>
      getProjectWorktreeFileHistory(
        projectId,
        worktreeId,
        selection!.path,
        selection!.revision,
        pageParam,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const blame = useInfiniteQuery({
    enabled: open && Boolean(selection) && tab === "blame",
    initialPageParam: 0,
    queryKey: ["git-file-blame", projectId, worktreeId, selection],
    queryFn: ({ pageParam }) =>
      getProjectWorktreeFileBlame(
        projectId,
        worktreeId,
        selection!.path,
        selection!.revision,
        pageParam,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const compare = useMutation({
    mutationFn: ({
      base,
      contextLines,
      target,
    }: {
      base: string;
      contextLines: number;
      target: string;
    }) =>
      getProjectWorktreeRevisionDiff(
        projectId,
        worktreeId,
        target,
        base,
        selection!.path,
        contextLines,
      ),
  });
  const commits = useMemo(
    () => flattenFileHistoryPages(history.data?.pages),
    [history.data?.pages],
  );
  const blameRanges = useMemo(
    () => blame.data?.pages.flatMap(({ ranges }) => ranges) ?? [],
    [blame.data?.pages],
  );
  const inspect = () => {
    const nextPath = path.trim();
    const nextRevision = revision.trim();
    if (!nextPath || !nextRevision) return;
    setSelection({ path: nextPath, revision: nextRevision });
    setDiffContextLines(3);
    compare.reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88svh,900px)] w-[min(94vw,1100px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>File history and blame</DialogTitle>
          <DialogDescription>
            Inspect one path in this worktree without changing its checkout.
          </DialogDescription>
          <form
            className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              inspect();
            }}
          >
            <Input
              aria-label="Repository-relative path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="src/example.ts"
              className="h-8 font-mono text-xs"
            />
            <Input
              aria-label="Starting revision"
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              placeholder="HEAD"
              className="h-8 font-mono text-xs"
            />
            <Button size="sm" className="h-8" type="submit">
              <Search className="size-3.5" /> Inspect
            </Button>
          </form>
        </DialogHeader>
        <div className="flex h-9 shrink-0 items-end gap-1 border-b px-3">
          {(["history", "blame", "compare"] as FileToolTab[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "h-8 border-b-2 border-transparent px-3 text-xs capitalize text-muted-foreground",
                tab === value && "border-foreground text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
        {!selection ? (
          <ContentEmpty
            className="min-h-0"
            icon={<FileClock className="size-5 text-muted-foreground" />}
            description="Enter a repository-relative path to begin."
          />
        ) : tab === "history" ? (
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {history.isLoading ? (
              <ContentLoading label="Loading file history…" />
            ) : history.error ? (
              <InlineAlert
                className="m-6"
                tone="error"
                error={history.error}
                fallback="Git request failed."
              />
            ) : (
              <>
                {commits.map((commit) => (
                  <button
                    key={commit.hash}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenCommit(commit.hash);
                    }}
                    className="grid h-10 w-full grid-cols-[95px_minmax(180px,1fr)_150px_170px] items-center gap-3 px-4 text-left text-xs odd:bg-muted/[0.035] hover:bg-muted/50"
                  >
                    <span className="font-mono text-muted-foreground">
                      {commit.shortHash}
                    </span>
                    <span className="truncate font-medium">
                      {commit.subject}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {commit.authorName}
                    </span>
                    <span className="text-right text-[10px] text-muted-foreground">
                      {dateFormatter.format(new Date(commit.authoredAt))}
                    </span>
                  </button>
                ))}
                {commits.length === 0 ? (
                  <ContentEmpty description="No commits touch this path." />
                ) : null}
                {history.hasNextPage ? (
                  <div className="grid h-12 place-items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={history.isFetchingNextPage}
                      onClick={() => void history.fetchNextPage()}
                    >
                      {history.isFetchingNextPage ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : null}
                      Load more
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : tab === "blame" ? (
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {blame.isLoading ? (
              <ContentLoading label="Loading blame…" />
            ) : blame.error ? (
              <InlineAlert
                className="m-6"
                tone="error"
                error={blame.error}
                fallback="Git request failed."
              />
            ) : (
              <>
                {blameRanges.map((range) => (
                  <button
                    key={`${range.commit}:${range.startLine}`}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenCommit(range.commit);
                    }}
                    className="grid w-full grid-cols-[170px_minmax(0,1fr)] border-b border-border/40 px-4 py-2 text-left text-xs hover:bg-muted/40"
                  >
                    <span className="pr-4 text-muted-foreground">
                      <span className="block truncate text-foreground">
                        {range.authorName}
                      </span>
                      <span className="font-mono">{range.shortCommit}</span>
                      <span className="block text-[10px]">
                        L{range.startLine}–{range.endLine}
                      </span>
                    </span>
                    <pre className="overflow-hidden whitespace-pre-wrap font-mono text-[11px] leading-5">
                      {range.lines
                        .map(
                          (line, index) =>
                            `${String(range.startLine + index).padStart(5)}  ${line}`,
                        )
                        .join("\n")}
                    </pre>
                  </button>
                ))}
                {blameRanges.length === 0 ? (
                  <ContentEmpty description="No blame lines were returned." />
                ) : null}
                {blame.hasNextPage ? (
                  <div className="grid h-12 place-items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={blame.isFetchingNextPage}
                      onClick={() => void blame.fetchNextPage()}
                    >
                      {blame.isFetchingNextPage ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : null}
                      Load more lines
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid shrink-0 gap-2 border-b p-3 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                aria-label="Base revision"
                value={left}
                onChange={(event) => setLeft(event.target.value)}
                className="h-8 font-mono text-xs"
              />
              <Input
                aria-label="Target revision"
                value={right}
                onChange={(event) => setRight(event.target.value)}
                className="h-8 font-mono text-xs"
              />
              <Button
                size="sm"
                className="h-8"
                disabled={!left.trim() || !right.trim() || compare.isPending}
                onClick={() =>
                  compare.mutate({
                    base: left.trim(),
                    contextLines: diffContextLines,
                    target: right.trim(),
                  })
                }
              >
                {compare.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitCommitHorizontal className="size-3.5" />
                )}
                Compare
              </Button>
            </div>
            <GitPatchView
              error={compare.error}
              loading={compare.isPending}
              newFile={compare.data?.newFile}
              newLabel={right}
              oldLabel={left}
              onClose={() => compare.reset()}
              onContextLinesChange={(contextLines) => {
                setDiffContextLines(contextLines);
                compare.mutate({
                  base: left.trim(),
                  contextLines,
                  target: right.trim(),
                });
              }}
              onOpenFile={
                onOpenFile ? () => onOpenFile(selection.path) : undefined
              }
              oldFile={compare.data?.oldFile}
              originalPath={compare.data?.originalPath}
              patch={compare.data?.patch}
              path={selection.path}
              showClose={false}
              subtitle={`${left} → ${right}`}
              truncated={compare.data?.truncated ?? false}
              binary={compare.data?.binary}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
