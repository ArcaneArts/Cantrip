import type {
  GitCommitSearchQuery,
  GitCommitSearchResult,
} from "@cantrip/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { searchProjectWorktreeCommits } from "@/lib/api";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface CommitSearchDraft {
  author: string;
  dateFrom: string;
  dateTo: string;
  hash: string;
  message: string;
  path: string;
  ref: string;
  scope: "all" | "branch" | "tag";
}

const emptyDraft: CommitSearchDraft = {
  author: "",
  dateFrom: "",
  dateTo: "",
  hash: "",
  message: "",
  path: "",
  ref: "",
  scope: "all",
};

export function normalizeCommitSearch(
  draft: CommitSearchDraft,
): GitCommitSearchQuery | null {
  const value = (candidate: string) => candidate.trim() || null;
  const query: GitCommitSearchQuery = {
    message: value(draft.message),
    author: value(draft.author),
    hash: value(draft.hash)?.toLowerCase() ?? null,
    dateFrom: value(draft.dateFrom),
    dateTo: value(draft.dateTo),
    path: value(draft.path),
    branch: draft.scope === "branch" ? value(draft.ref) : null,
    tag: draft.scope === "tag" ? value(draft.ref) : null,
  };
  return Object.values(query).some(Boolean) ? query : null;
}

export function flattenCommitSearchPages(
  pages: GitCommitSearchResult[] | undefined,
) {
  return pages?.flatMap(({ commits }) => commits) ?? [];
}

export function GitCommitSearchDialog({
  onOpenChange,
  onOpenCommit,
  open,
  projectId,
  worktreeId,
}: {
  onOpenChange(open: boolean): void;
  onOpenCommit(revision: string): void;
  open: boolean;
  projectId: string;
  worktreeId: string;
}) {
  const [draft, setDraft] = useState<CommitSearchDraft>(emptyDraft);
  const [query, setQuery] = useState<GitCommitSearchQuery | null>(null);
  const search = useInfiniteQuery({
    enabled: open && Boolean(query),
    initialPageParam: 0,
    queryKey: ["git-commit-search", projectId, worktreeId, query],
    queryFn: ({ pageParam }) =>
      searchProjectWorktreeCommits(projectId, worktreeId, query!, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const commits = useMemo(
    () => flattenCommitSearchPages(search.data?.pages),
    [search.data?.pages],
  );
  const update = (field: keyof CommitSearchDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88svh,820px)] w-[min(94vw,1050px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>Search commits</DialogTitle>
          <DialogDescription>
            Combine message, author, hash, dates, path, and one branch or tag.
          </DialogDescription>
          <form
            className="mt-3 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(normalizeCommitSearch(draft));
            }}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                aria-label="Commit message"
                value={draft.message}
                onChange={(event) => update("message", event.target.value)}
                placeholder="Message contains"
                className="h-8 text-xs"
              />
              <Input
                aria-label="Commit author"
                value={draft.author}
                onChange={(event) => update("author", event.target.value)}
                placeholder="Author name or email"
                className="h-8 text-xs"
              />
              <Input
                aria-label="Commit hash"
                value={draft.hash}
                onChange={(event) => update("hash", event.target.value)}
                placeholder="Hash prefix"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_150px_150px_110px_1fr_auto]">
              <Input
                aria-label="Repository path"
                value={draft.path}
                onChange={(event) => update("path", event.target.value)}
                placeholder="Path"
                className="h-8 font-mono text-xs"
              />
              <Input
                aria-label="Start date"
                type="date"
                value={draft.dateFrom}
                onChange={(event) => update("dateFrom", event.target.value)}
                className="h-8 text-xs"
              />
              <Input
                aria-label="End date"
                type="date"
                value={draft.dateTo}
                onChange={(event) => update("dateTo", event.target.value)}
                className="h-8 text-xs"
              />
              <select
                aria-label="Revision scope"
                value={draft.scope}
                onChange={(event) => update("scope", event.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="all">All refs</option>
                <option value="branch">Branch</option>
                <option value="tag">Tag</option>
              </select>
              <Input
                aria-label="Branch or tag"
                disabled={draft.scope === "all"}
                value={draft.ref}
                onChange={(event) => update("ref", event.target.value)}
                placeholder={draft.scope === "tag" ? "Tag" : "Branch"}
                className="h-8 font-mono text-xs"
              />
              <Button
                size="sm"
                className="h-8"
                type="submit"
                disabled={!normalizeCommitSearch(draft)}
              >
                <Search className="size-3.5" /> Search
              </Button>
            </div>
          </form>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto py-2">
          {!query ? (
            <div className="grid min-h-64 place-items-center text-center text-sm text-muted-foreground">
              <div>
                <GitCommitHorizontal className="mx-auto mb-3 size-6" />
                Add at least one filter to search this repository.
              </div>
            </div>
          ) : search.isLoading ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Searching…
              </span>
            </div>
          ) : search.error ? (
            <div className="grid min-h-64 place-items-center p-6 text-center text-sm text-destructive">
              {search.error instanceof Error
                ? search.error.message
                : "Commit search failed."}
            </div>
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
                  className="grid h-10 w-full grid-cols-[95px_minmax(220px,1fr)_160px_175px] items-center gap-3 px-4 text-left text-xs odd:bg-muted/[0.035] hover:bg-muted/50"
                >
                  <span className="font-mono text-muted-foreground">
                    {commit.shortHash}
                  </span>
                  <span className="truncate font-medium">{commit.subject}</span>
                  <span className="truncate text-muted-foreground">
                    {commit.authorName}
                  </span>
                  <span className="text-right text-[10px] text-muted-foreground">
                    {dateFormatter.format(new Date(commit.authoredAt))}
                  </span>
                </button>
              ))}
              {commits.length === 0 ? (
                <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
                  No commits matched every filter.
                </div>
              ) : null}
              {search.hasNextPage ? (
                <div className="grid h-12 place-items-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={search.isFetchingNextPage}
                    onClick={() => void search.fetchNextPage()}
                  >
                    {search.isFetchingNextPage ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
