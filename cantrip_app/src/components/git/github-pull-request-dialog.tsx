import type {
  GithubPullRequestCheck,
  GithubPullRequestDetail,
  GithubPullRequestFile,
  GithubPullRequestLifecycleAction,
  GithubPullRequestReviewAction,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  FileDiff,
  GitCommitHorizontal,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getGithubPullRequest,
  runGithubPullRequestReviewAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView } from "./git-patch-view";
import { GithubPullRequestLifecycleDialog } from "./github-pull-request-lifecycle-dialog";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type PullRequestTab = "overview" | "files" | "commits" | "checks";

export function pullRequestCheckLabel(check: GithubPullRequestCheck): string {
  if (check.status !== "completed") return "Running";
  return (check.conclusion ?? "Completed").replaceAll("_", " ");
}

export function pullRequestFileSubtitle(file: GithubPullRequestFile): string {
  const rename = file.previousPath ? `${file.previousPath} → ` : "";
  return `${rename}${file.status} · +${file.additions} −${file.deletions}`;
}

function CheckIcon({ check }: { check: GithubPullRequestCheck }) {
  if (check.status !== "completed") {
    return <Clock3 className="size-4 text-amber-500" />;
  }
  if (check.conclusion === "success") {
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }
  if (
    ["failure", "error", "timed_out", "cancelled"].includes(
      check.conclusion ?? "",
    )
  ) {
    return <AlertCircle className="size-4 text-destructive" />;
  }
  return <CircleDot className="size-4 text-muted-foreground" />;
}

function TruncatedNotice({ children }: { children: string }) {
  return (
    <p className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
      {children}
    </p>
  );
}

function Overview({
  detail,
  error,
  onAction,
  pending,
}: {
  detail: GithubPullRequestDetail;
  error: unknown;
  onAction(action: GithubPullRequestReviewAction): Promise<void>;
  pending: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const submit = async (action: GithubPullRequestReviewAction) => {
    try {
      await onAction(action);
      setDraft("");
    } catch {
      // The shared mutation error remains visible beside the review form.
    }
  };
  return (
    <div className="space-y-6 overflow-y-auto p-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            "Mergeability",
            detail.mergeable === null
              ? "Calculating"
              : detail.mergeable
                ? "Mergeable"
                : "Blocked",
          ],
          ["Reviews", detail.reviewDecision.replaceAll("-", " ")],
          ["Checks", detail.checksState],
          ["Change", `+${detail.additions} −${detail.deletions}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p className="mt-1 capitalize">{value}</p>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Description
        </h3>
        {detail.body ? (
          <Markdown>{detail.body}</Markdown>
        ) : (
          <p className="text-sm italic text-muted-foreground">
            No description provided.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Reviews ({detail.reviews.length})
        </h3>
        {detail.requestedReviewers.length ? (
          <p className="mb-2 text-xs text-muted-foreground">
            Awaiting:{" "}
            {detail.requestedReviewers.map((name) => `@${name}`).join(", ")}
          </p>
        ) : null}
        <div className="space-y-2">
          {detail.reviews.map((review) => (
            <article
              key={review.id}
              className="rounded-lg bg-muted/25 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium">@{review.author}</span>
                <Badge variant="outline" className="capitalize">
                  {review.state.replaceAll("-", " ")}
                </Badge>
              </div>
              {review.body ? (
                <div className="mt-2">
                  <Markdown>{review.body}</Markdown>
                </div>
              ) : null}
            </article>
          ))}
          {detail.reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviews yet.</p>
          ) : null}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <FileDiff className="size-3.5" /> Inline review threads (
          {detail.reviewThreads.length})
        </h3>
        <div className="space-y-3">
          {detail.reviewThreads.map((thread) => (
            <article key={thread.id} className="rounded-lg bg-muted/25 p-3">
              <p className="mb-2 font-mono text-xs text-muted-foreground">
                {thread.path}
                {thread.line ? `:${thread.line}` : ""}
                {thread.side ? ` · ${thread.side.toLowerCase()}` : ""}
              </p>
              <div className="space-y-3">
                {thread.comments.map((comment) => (
                  <div key={comment.id}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">@{comment.author}</span>
                      <span className="text-muted-foreground">
                        {dateFormatter.format(new Date(comment.createdAt))}
                      </span>
                    </div>
                    <Markdown>{comment.body}</Markdown>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  aria-label={`Reply to thread on ${thread.path}`}
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                  placeholder="Reply to thread…"
                  value={replyDrafts[thread.id] ?? ""}
                  onChange={(event) =>
                    setReplyDrafts({
                      ...replyDrafts,
                      [thread.id]: event.target.value,
                    })
                  }
                />
                <Button
                  size="sm"
                  className="h-8"
                  disabled={pending || !(replyDrafts[thread.id] ?? "").trim()}
                  onClick={async () => {
                    const body = (replyDrafts[thread.id] ?? "").trim();
                    if (!body) return;
                    try {
                      await onAction({
                        type: "reply",
                        commentId: thread.comments[0]!.id,
                        body,
                      });
                      setReplyDrafts({ ...replyDrafts, [thread.id]: "" });
                    } catch {
                      // The shared mutation error remains visible below.
                    }
                  }}
                >
                  Reply
                </Button>
              </div>
            </article>
          ))}
          {detail.reviewThreads.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No inline review threads yet. Select a line in Files to start one.
            </p>
          ) : null}
          {detail.reviewThreadsTruncated ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Showing the first 100 inline comments. Open GitHub for the full
              review conversation.
            </p>
          ) : null}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <MessageSquare className="size-3.5" /> Conversation (
          {detail.commentCount})
        </h3>
        <div className="space-y-2">
          {detail.comments.map((comment) => (
            <article
              key={comment.id}
              className="rounded-lg bg-muted/25 px-3 py-2"
            >
              <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                <span className="font-medium">@{comment.author}</span>
                <span className="text-muted-foreground">
                  {dateFormatter.format(new Date(comment.createdAt))}
                </span>
              </div>
              <Markdown>{comment.body}</Markdown>
            </article>
          ))}
          {detail.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : null}
          {detail.commentsTruncated ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Showing the first 100 comments. Open GitHub for the complete
              conversation.
            </p>
          ) : null}
        </div>
      </section>

      {detail.state === "open" && !detail.merged ? (
        <section>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Comment or review
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="mt-2 min-h-24 w-full resize-y rounded-lg border bg-background p-3 text-sm font-normal normal-case tracking-normal"
              placeholder="Leave a general comment, approval note, or requested changes…"
            />
          </label>
          {error ? (
            <p className="mb-2 text-xs text-destructive">
              {error instanceof Error ? error.message : "Review action failed."}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !draft.trim()}
              onClick={() => submit({ type: "comment", body: draft.trim() })}
            >
              <MessageSquare className="size-3.5" /> Comment
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                submit({
                  type: "submit-review",
                  review: { event: "approve", body: draft.trim() },
                })
              }
            >
              <CheckCircle2 className="size-3.5" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={pending || !draft.trim()}
              onClick={() =>
                submit({
                  type: "submit-review",
                  review: { event: "request-changes", body: draft.trim() },
                })
              }
            >
              <AlertCircle className="size-3.5" /> Request changes
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Files({
  detail,
  error,
  onAction,
  pending,
}: {
  detail: GithubPullRequestDetail;
  error: unknown;
  onAction(action: GithubPullRequestReviewAction): Promise<void>;
  pending: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    detail.files[0]?.path ?? null,
  );
  const [commentTarget, setCommentTarget] = useState<{
    line: number;
    path: string;
    side: "LEFT" | "RIGHT";
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const selected =
    detail.files.find((file) => file.path === selectedPath) ?? detail.files[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {commentTarget ? (
        <form
          className="flex shrink-0 items-start gap-2 border-b bg-muted/20 p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!commentBody.trim()) return;
            try {
              await onAction({
                type: "inline-comment",
                comment: {
                  body: commentBody.trim(),
                  path: commentTarget.path,
                  line: commentTarget.line,
                  side: commentTarget.side,
                  startLine: null,
                  startSide: null,
                },
              });
              setCommentBody("");
              setCommentTarget(null);
            } catch {
              // The shared mutation error remains visible below the editor.
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <p className="mb-1 font-mono text-[10px] text-muted-foreground">
              {commentTarget.path}:{commentTarget.line} ·{" "}
              {commentTarget.side.toLowerCase()} side
            </p>
            <textarea
              autoFocus
              className="min-h-16 w-full resize-y rounded-md border bg-background p-2 text-xs"
              placeholder="Add an inline review comment…"
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
            />
            {error ? (
              <p className="mt-1 text-xs text-destructive">
                {error instanceof Error
                  ? error.message
                  : "Inline comment failed."}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCommentTarget(null);
              setCommentBody("");
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !commentBody.trim()}
          >
            <Send className="size-3.5" /> Comment
          </Button>
        </form>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r">
          {detail.filesTruncated ? (
            <TruncatedNotice>
              Showing the first 100 changed files.
            </TruncatedNotice>
          ) : null}
          {detail.files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              className={cn(
                "flex h-10 w-full items-center gap-2 px-3 text-left text-xs hover:bg-muted/50",
                selected?.path === file.path && "bg-muted",
              )}
            >
              <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono">
                {file.path}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                +{file.additions} −{file.deletions}
              </span>
            </button>
          ))}
        </div>
        {selected ? (
          <GitPatchView
            error={null}
            loading={false}
            newLabel={selected.path}
            oldLabel={selected.previousPath ?? selected.path}
            onClose={() => setSelectedPath(null)}
            onCommentLine={(line, side) => {
              setCommentTarget({ line, side, path: selected.path });
              setCommentBody("");
            }}
            originalPath={selected.previousPath}
            patch={selected.patch ?? undefined}
            path={selected.path}
            showClose={false}
            subtitle={pullRequestFileSubtitle(selected)}
            truncated={selected.patchTruncated}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            No changed files to display.
          </div>
        )}
      </div>
    </div>
  );
}

function Commits({ detail }: { detail: GithubPullRequestDetail }) {
  return (
    <div className="overflow-y-auto">
      {detail.commitsTruncated ? (
        <TruncatedNotice>
          Showing the first 100 pull request commits.
        </TruncatedNotice>
      ) : null}
      {detail.commits.map((commit) => (
        <a
          key={commit.sha}
          href={commit.url}
          target="_blank"
          rel="noreferrer"
          className="grid min-h-11 grid-cols-[90px_minmax(240px,1fr)_160px_150px] items-center gap-3 px-4 text-xs odd:bg-muted/[0.035] hover:bg-muted/40"
        >
          <span className="flex items-center gap-2 font-mono text-muted-foreground">
            <GitCommitHorizontal className="size-3.5" /> {commit.shortSha}
          </span>
          <span className="truncate font-medium">
            {commit.message.split("\n", 1)[0]}
          </span>
          <span className="truncate text-muted-foreground">
            {commit.author}
          </span>
          <span className="text-right text-muted-foreground">
            {commit.authoredAt
              ? dateFormatter.format(new Date(commit.authoredAt))
              : "Unknown date"}
          </span>
        </a>
      ))}
      {detail.commits.length === 0 ? (
        <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
          No commits to display.
        </div>
      ) : null}
    </div>
  );
}

function Checks({ detail }: { detail: GithubPullRequestDetail }) {
  return (
    <div className="overflow-y-auto">
      {detail.checksTruncated ? (
        <TruncatedNotice>
          Showing the first 200 check and status results.
        </TruncatedNotice>
      ) : null}
      {detail.checks.map((check) => (
        <article
          key={`${check.source}:${check.id}`}
          className="flex min-h-12 items-start gap-3 px-4 py-3 odd:bg-muted/[0.035]"
        >
          <CheckIcon check={check} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{check.name}</p>
            <p className="mt-0.5 text-xs capitalize text-muted-foreground">
              {pullRequestCheckLabel(check)} · {check.source.replace("-", " ")}
            </p>
            {check.summary ? (
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
                {check.summary}
              </p>
            ) : null}
          </div>
          {check.url ? (
            <Button variant="ghost" size="icon" className="size-7" asChild>
              <a href={check.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                <span className="sr-only">Open check details</span>
              </a>
            </Button>
          ) : null}
        </article>
      ))}
      {detail.checks.length === 0 ? (
        <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
          No checks reported for this commit.
        </div>
      ) : null}
    </div>
  );
}

export function GithubPullRequestDialog({
  onOpenChange,
  projectId,
  pullRequestNumber,
  worktreeId,
}: {
  onOpenChange(open: boolean): void;
  projectId: string;
  pullRequestNumber: number | null;
  worktreeId: string;
}) {
  const [tab, setTab] = useState<PullRequestTab>("overview");
  const [lifecycleAction, setLifecycleAction] =
    useState<GithubPullRequestLifecycleAction | null>(null);
  const queryClient = useQueryClient();
  const detailKey = [
    "github-pull-request",
    projectId,
    worktreeId,
    pullRequestNumber,
  ];
  const detail = useQuery({
    enabled: pullRequestNumber !== null,
    queryKey: detailKey,
    queryFn: () =>
      getGithubPullRequest(projectId, worktreeId, pullRequestNumber!),
  });
  const action = useMutation({
    mutationFn: (input: GithubPullRequestReviewAction) =>
      runGithubPullRequestReviewAction(
        projectId,
        worktreeId,
        pullRequestNumber!,
        input,
      ),
    onSuccess: async (updated) => {
      queryClient.setQueryData(detailKey, updated);
      await queryClient.invalidateQueries({
        queryKey: ["github-issues", projectId, "pull-request"],
      });
    },
  });
  useEffect(() => {
    setTab("overview");
    setLifecycleAction(null);
  }, [pullRequestNumber]);

  return (
    <>
      <Dialog open={pullRequestNumber !== null} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[min(90svh,900px)] w-[min(96vw,1200px)] max-w-none flex-col overflow-hidden p-0">
          {detail.isLoading ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : detail.isError || !detail.data ? (
            <DialogHeader className="p-6 pr-12">
              <DialogTitle>Pull request could not be loaded</DialogTitle>
              <DialogDescription>
                {detail.error instanceof Error
                  ? detail.error.message
                  : "GitHub request failed."}
              </DialogDescription>
            </DialogHeader>
          ) : (
            <>
              <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={detail.data.merged ? "default" : "secondary"}>
                    {detail.data.merged
                      ? "merged"
                      : detail.data.draft
                        ? "draft"
                        : detail.data.state}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    #{detail.data.number}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {detail.data.headRef} → {detail.data.baseRef}
                  </span>
                </div>
                <div className="mt-1 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="truncate text-left text-lg">
                      {detail.data.title}
                    </DialogTitle>
                    <DialogDescription className="text-left">
                      @{detail.data.author} · {detail.data.commitCount} commits
                      · {detail.data.changedFileCount} files
                    </DialogDescription>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {detail.data.state === "open" && detail.data.draft ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setLifecycleAction({ type: "mark-ready" })
                        }
                      >
                        Ready
                      </Button>
                    ) : null}
                    {detail.data.state === "open" &&
                    !detail.data.draft &&
                    !detail.data.merged ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          setLifecycleAction({
                            type: "merge",
                            method: "squash",
                            commitTitle: null,
                            commitMessage: null,
                          })
                        }
                      >
                        Merge
                      </Button>
                    ) : null}
                    {detail.data.state === "open" && !detail.data.merged ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10"
                        onClick={() => setLifecycleAction({ type: "close" })}
                      >
                        Close
                      </Button>
                    ) : null}
                    {detail.data.state === "closed" && !detail.data.merged ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setLifecycleAction({ type: "reopen" })}
                      >
                        Reopen
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" asChild>
                      <a
                        href={detail.data.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="size-3.5" /> GitHub
                      </a>
                    </Button>
                  </div>
                </div>
              </DialogHeader>
              <div className="flex h-9 shrink-0 items-end gap-1 border-b px-3">
                {(
                  ["overview", "files", "commits", "checks"] as PullRequestTab[]
                ).map((value) => (
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
                    {value === "files"
                      ? ` ${detail.data.changedFileCount}`
                      : ""}
                    {value === "commits" ? ` ${detail.data.commitCount}` : ""}
                    {value === "checks" ? ` ${detail.data.checks.length}` : ""}
                  </button>
                ))}
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                {tab === "overview" ? (
                  <Overview
                    detail={detail.data}
                    error={action.error}
                    pending={action.isPending}
                    onAction={async (input) => {
                      await action.mutateAsync(input);
                    }}
                  />
                ) : null}
                {tab === "files" ? (
                  <Files
                    detail={detail.data}
                    error={action.error}
                    pending={action.isPending}
                    onAction={async (input) => {
                      await action.mutateAsync(input);
                    }}
                  />
                ) : null}
                {tab === "commits" ? <Commits detail={detail.data} /> : null}
                {tab === "checks" ? <Checks detail={detail.data} /> : null}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {pullRequestNumber !== null ? (
        <GithubPullRequestLifecycleDialog
          action={lifecycleAction}
          onOpenChange={(open) => {
            if (!open) setLifecycleAction(null);
          }}
          projectId={projectId}
          worktreeId={worktreeId}
          pullRequestNumber={pullRequestNumber}
          onApplied={(updated) => {
            queryClient.setQueryData(detailKey, updated);
            void queryClient.invalidateQueries({
              queryKey: ["github-issues", projectId, "pull-request"],
            });
          }}
        />
      ) : null}
    </>
  );
}
