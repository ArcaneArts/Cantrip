import type {
  GithubIssueDetail,
  GithubIssueList,
  GithubIssueState,
  ProjectSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
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
  closeGithubIssue,
  commentOnGithubIssue,
  getGithubIssue,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub request failed.";
}

function IssueDialog({
  issueNumber,
  onOpenChange,
  project,
}: {
  issueNumber: number | null;
  onOpenChange(open: boolean): void;
  project: ProjectSummary;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const detailKey = ["github-issue", project.id, issueNumber];
  const issue = useQuery({
    enabled: issueNumber !== null,
    queryFn: () => getGithubIssue(project.id, issueNumber!),
    queryKey: detailKey,
  });
  const refreshLists = async (detail: GithubIssueDetail) => {
    queryClient.setQueryData(detailKey, detail);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["github-issues", project.id, "open"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["github-issues", project.id, "closed"],
      }),
    ]);
  };
  const comment = useMutation({
    mutationFn: (body: string) =>
      commentOnGithubIssue(project.id, issueNumber!, body),
    onSuccess: async (detail) => {
      setDraft("");
      await refreshLists(detail);
    },
  });
  const close = useMutation({
    mutationFn: (body: string) =>
      closeGithubIssue(project.id, issueNumber!, body.trim() || null),
    onSuccess: async (detail) => {
      setDraft("");
      await refreshLists(detail);
    },
  });
  const pending = comment.isPending || close.isPending;

  return (
    <Dialog
      open={issueNumber !== null}
      onOpenChange={(open) => {
        if (!open) setDraft("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-3xl flex-col overflow-hidden p-0">
        {issue.isLoading ? (
          <div className="grid min-h-80 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : issue.isError || !issue.data ? (
          <div className="p-6">
            <DialogHeader>
              <DialogTitle>Issue could not be loaded</DialogTitle>
              <DialogDescription>{errorText(issue.error)}</DialogDescription>
            </DialogHeader>
          </div>
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    issue.data.state === "open" ? "secondary" : "outline"
                  }
                  className="gap-1.5"
                >
                  {issue.data.state === "closed" ? (
                    <CheckCircle2 className="size-3" />
                  ) : null}
                  {issue.data.state}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  #{issue.data.number}
                </span>
              </div>
              <DialogTitle className="mt-2 text-left text-xl leading-7">
                {issue.data.title}
              </DialogTitle>
              <DialogDescription className="text-left">
                Opened by @{issue.data.author} on{" "}
                {dateFormatter.format(new Date(issue.data.createdAt))}
              </DialogDescription>
              {issue.data.labels.length ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {issue.data.labels.map((label) => (
                    <span
                      key={label.name}
                      className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        borderColor: `#${label.color}80`,
                        backgroundColor: `#${label.color}20`,
                      }}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              <section>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Description
                </h3>
                {issue.data.body ? (
                  <Markdown>{issue.data.body}</Markdown>
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    No description provided.
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <MessageSquare className="size-3.5" />
                  Comments ({issue.data.comments.length})
                </h3>
                <div className="space-y-3">
                  {issue.data.comments.map((entry) => (
                    <article
                      key={entry.id}
                      className="rounded-xl bg-muted/30 px-4 py-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium">@{entry.author}</span>
                        <span className="text-muted-foreground">
                          {dateFormatter.format(new Date(entry.createdAt))}
                        </span>
                      </div>
                      {entry.body ? (
                        <Markdown>{entry.body}</Markdown>
                      ) : (
                        <p className="text-sm italic text-muted-foreground">
                          Empty comment.
                        </p>
                      )}
                    </article>
                  ))}
                  {issue.data.comments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No comments yet.
                    </p>
                  ) : null}
                </div>
              </section>

              <section>
                <label
                  htmlFor="github-issue-comment"
                  className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Add a comment
                </label>
                <textarea
                  id="github-issue-comment"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a comment, or include it while closing…"
                  className="min-h-28 w-full resize-y rounded-xl border bg-background p-3 text-sm outline-none ring-ring focus:ring-2"
                />
                {comment.isError || close.isError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {errorText(comment.error ?? close.error)}
                  </p>
                ) : null}
              </section>
            </div>

            <DialogFooter className="shrink-0 border-t px-6 py-4 sm:justify-between">
              <Button variant="outline" asChild>
                <a href={issue.data.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open in GitHub
                </a>
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {issue.data.state === "open" ? (
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={pending}
                    onClick={() => close.mutate(draft)}
                  >
                    {close.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )}
                    Close issue
                  </Button>
                ) : null}
                <Button
                  disabled={pending || !draft.trim()}
                  onClick={() => comment.mutate(draft.trim())}
                >
                  {comment.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                  Comment
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function GithubIssuesView({
  error,
  hasNextPage,
  isFetching,
  isFetchingNextPage,
  isLoading,
  issues,
  onLoadMore,
  onRefresh,
  onStateChange,
  project,
  state,
}: {
  error: unknown;
  hasNextPage: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  issues: GithubIssueList | undefined;
  onLoadMore(): void;
  onRefresh(): void;
  onStateChange(state: GithubIssueState): void;
  project: ProjectSummary;
  state: GithubIssueState;
}) {
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = listRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) onLoadMore();
      },
      { root, rootMargin: "300px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-4">
        <div className="flex rounded-lg bg-muted/50 p-0.5">
          {(["open", "closed"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onStateChange(candidate)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs capitalize text-muted-foreground",
                candidate === state &&
                  "bg-background font-medium text-foreground shadow-sm",
              )}
            >
              {candidate}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={isFetching}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          {isFetching ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="grid min-h-64 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="m-5 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
            {errorText(error)}
          </div>
        ) : !issues?.issues.length ? (
          <div className="grid min-h-64 place-items-center text-center">
            <div>
              <CheckCircle2 className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 font-medium">No {state} issues</p>
            </div>
          </div>
        ) : (
          <div className="min-w-[680px] py-2 text-xs">
            <div className="sticky top-0 z-10 grid h-7 grid-cols-[70px_minmax(320px,1fr)_130px_90px_100px] items-center border-y bg-muted/95 px-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
              <span>Issue</span>
              <span>Title</span>
              <span>Author</span>
              <span>Comments</span>
              <span className="text-right">Updated</span>
            </div>
            {issues.issues.map((issue) => (
              <button
                key={issue.number}
                type="button"
                data-high-contrast-row
                onClick={() => setSelectedIssue(issue.number)}
                className="grid h-10 w-full grid-cols-[70px_minmax(320px,1fr)_130px_90px_100px] items-center px-4 text-left odd:bg-muted/[0.035] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="font-mono text-muted-foreground">
                  #{issue.number}
                </span>
                <span className="flex min-w-0 items-center gap-2 pr-4">
                  <span className="truncate font-medium">{issue.title}</span>
                  {issue.labels.slice(0, 2).map((label) => (
                    <span
                      key={label.name}
                      className="max-w-24 truncate rounded-full border px-1.5 py-0.5 text-[9px]"
                      style={{ borderColor: `#${label.color}80` }}
                    >
                      {label.name}
                    </span>
                  ))}
                </span>
                <span className="truncate text-muted-foreground">
                  @{issue.author}
                </span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <MessageSquare className="size-3" />
                  {issue.commentCount}
                </span>
                <span className="text-right text-[10px] text-muted-foreground">
                  {dateFormatter.format(new Date(issue.updatedAt))}
                </span>
              </button>
            ))}
            {hasNextPage || isFetchingNextPage ? (
              <div
                ref={loadMoreRef}
                className="grid h-12 place-items-center text-muted-foreground"
              >
                {isFetchingNextPage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <span>Scroll to load more</span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <IssueDialog
        issueNumber={selectedIssue}
        project={project}
        onOpenChange={(open) => {
          if (!open) setSelectedIssue(null);
        }}
      />
    </div>
  );
}
