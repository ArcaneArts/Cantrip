import type {
  ChatSummary,
  GithubPullRequestCheck,
  GithubPullRequestChecks,
  GithubPullRequestCommits,
  GithubPullRequestFile,
  GithubPullRequestFiles,
  GithubPullRequestLifecycleAction,
  GithubPullRequestAgentContextRequest,
  GithubPullRequestOverview,
  GithubPullRequestReviewAction,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  ExternalLink,
  FileDiff,
  GitCommitHorizontal,
  GitBranch,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

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
  checkoutGithubPullRequest,
  generateProjectWorktreeGitDraft,
  getGithubPullRequestChecks,
  getGithubPullRequestCommits,
  getGithubPullRequestFiles,
  getGithubPullRequestOverview,
  runGithubPullRequestReviewAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitPatchView, gitDiffImagePreviewFromUrl } from "./git-patch-view";
import { GitAgentDraftDialog } from "./git-agent-draft-dialog";
import {
  GitMobileInspectorClose,
  gitMobileInspectorClassName,
} from "./git-mobile-inspector";
import { GithubPullRequestLifecycleDialog } from "./github-pull-request-lifecycle-dialog";
import {
  parseGithubActionsUrl,
  type GithubActionsTarget,
} from "./github-actions-model";
import type { GithubAgentWorkflowCleanupInput } from "./github-agent-workflow";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type PullRequestTab = "overview" | "files" | "commits" | "checks";

export function pullRequestCheckLabel(check: GithubPullRequestCheck): string {
  if (check.status !== "completed") return "Running";
  return (check.conclusion ?? "Completed").replaceAll("_", " ");
}

export function isFailedPullRequestCheck(
  check: GithubPullRequestCheck,
): boolean {
  return (
    check.status === "completed" &&
    ["failure", "error", "timed_out", "cancelled"].includes(
      check.conclusion ?? "",
    )
  );
}

export function pullRequestFileSubtitle(file: GithubPullRequestFile): string {
  const rename = file.previousPath ? `${file.previousPath} → ` : "";
  return `${rename}${file.status} · +${file.additions} −${file.deletions}`;
}

export function mergeCheckedOutWorktree(
  current: ProjectWorktreeSummary[],
  worktree: ProjectWorktreeSummary,
): ProjectWorktreeSummary[] {
  return [...current.filter(({ id }) => id !== worktree.id), worktree];
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

function DataWarnings({
  warnings = [],
}: {
  warnings?: Array<{ message: string; section: string }>;
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
      {warnings.map((warning, index) => (
        <p key={`${warning.section}:${index}`}>
          {warning.section.replaceAll("-", " ")}: {warning.message}
        </p>
      ))}
    </div>
  );
}

function SectionState({
  error,
  loading,
  onRetry,
}: {
  error: unknown;
  loading: boolean;
  onRetry(): void;
}) {
  if (loading) {
    return (
      <div className="grid min-h-48 flex-1 place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="grid min-h-48 flex-1 place-items-center p-6 text-center">
      <div>
        <AlertCircle className="mx-auto size-5 text-destructive" />
        <p className="mt-2 text-sm font-medium">This section is unavailable</p>
        <p className="mt-1 max-w-lg text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "GitHub request failed."}
        </p>
        <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function Overview({
  detail,
  error,
  onAction,
  pending,
}: {
  detail: GithubPullRequestOverview;
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
      <DataWarnings warnings={detail.warnings} />
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
          [
            "Checks",
            detail.checksState === "unknown"
              ? "Open Checks tab"
              : detail.checksState,
          ],
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
        <section className="sticky bottom-0 z-10 -mx-5 border-t bg-background/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
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

export function PullRequestFiles({
  detail,
  error,
  onAction,
  pending,
  reviewThreads = [],
}: {
  detail: GithubPullRequestFiles;
  error: unknown;
  onAction(action: GithubPullRequestReviewAction): Promise<void>;
  pending: boolean;
  reviewThreads?: GithubPullRequestOverview["reviewThreads"];
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    detail.files[0]?.path ?? null,
  );
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [commentTarget, setCommentTarget] = useState<{
    line: number;
    path: string;
    side: "LEFT" | "RIGHT";
    selectedText: string;
    startLine: number | null;
    startSide: "LEFT" | "RIGHT" | null;
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const selected = selectedPath
    ? (detail.files.find((file) => file.path === selectedPath) ??
      detail.files[0])
    : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        className="flex h-11 shrink-0 items-center gap-2 border-b px-3 text-left text-xs md:hidden"
        onClick={() => setFilePickerOpen(true)}
      >
        <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {selected?.path ?? "Choose a changed file"}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {detail.files.length} files
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <DataWarnings warnings={detail.warnings} />
      {commentTarget ? (
        <form
          className="flex shrink-0 flex-col items-stretch gap-2 border-b bg-muted/20 p-3 md:flex-row md:items-start"
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
                  startLine: commentTarget.startLine,
                  startSide: commentTarget.startSide,
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
              {commentTarget.path}:
              {commentTarget.startLine
                ? `${commentTarget.startLine}-${commentTarget.line}`
                : commentTarget.line}{" "}
              · {commentTarget.side.toLowerCase()} side
            </p>
            <textarea
              autoFocus
              className="min-h-16 w-full resize-y rounded-md border bg-background p-2 text-xs"
              placeholder="Add an inline review comment…"
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
            />
            {commentTarget.side === "RIGHT" ? (
              <Button
                className="mt-1 h-7 text-[10px]"
                onClick={() =>
                  setCommentBody(
                    `\`\`\`suggestion\n${commentTarget.selectedText}\n\`\`\``,
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Add suggested change
              </Button>
            ) : null}
            {error ? (
              <p className="mt-1 text-xs text-destructive">
                {error instanceof Error
                  ? error.message
                  : "Inline comment failed."}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
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
          </div>
        </form>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-72 shrink-0 overflow-y-auto border-r md:block">
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
            binary={selected.patch === null}
            commentTargets={reviewThreads.flatMap((thread) =>
              thread.path === selected.path && thread.line && thread.side
                ? [{ line: thread.line, side: thread.side }]
                : [],
            )}
            error={null}
            loading={false}
            newFile={
              gitDiffImagePreviewFromUrl(selected.path, selected.rawUrl) ??
              (selected.patch === null
                ? {
                    kind: "binary",
                    size: null,
                    mimeType: null,
                    base64: null,
                    truncated: false,
                  }
                : undefined)
            }
            newLabel={selected.path}
            oldLabel={selected.previousPath ?? selected.path}
            onClose={() => setFilePickerOpen(true)}
            onCommentRange={(selection) => {
              setCommentTarget({ ...selection, path: selected.path });
              setCommentBody("");
            }}
            openFileUrl={selected.blobUrl}
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
      <Dialog open={filePickerOpen} onOpenChange={setFilePickerOpen}>
        <DialogContent className="fixed inset-x-0 bottom-0 top-auto flex max-h-[75svh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-b-none rounded-t-2xl border-x-0 border-b-0 p-0 md:hidden">
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
          <DialogHeader className="shrink-0 border-b px-4 pb-3 pt-2 pr-12">
            <DialogTitle className="text-base">Changed files</DialogTitle>
            <DialogDescription>
              Choose a file to review its changes.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {detail.filesTruncated ? (
              <TruncatedNotice>
                Showing the first 100 changed files.
              </TruncatedNotice>
            ) : null}
            {detail.files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => {
                  setSelectedPath(file.path);
                  setFilePickerOpen(false);
                }}
                className={cn(
                  "flex min-h-12 w-full items-center gap-2 border-b border-border/50 px-4 py-2 text-left text-xs hover:bg-muted/50",
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
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Commits({ detail }: { detail: GithubPullRequestCommits }) {
  return (
    <div className="overflow-y-auto">
      <DataWarnings warnings={detail.warnings} />
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
          className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-3 text-xs odd:bg-muted/[0.035] hover:bg-muted/40 md:min-h-11 md:grid-cols-[90px_minmax(240px,1fr)_160px_150px] md:gap-y-0 md:border-0 md:py-0"
        >
          <span className="col-span-2 row-start-2 flex items-center gap-2 font-mono text-muted-foreground md:col-span-1 md:row-auto">
            <GitCommitHorizontal className="size-3.5" /> {commit.shortSha}
          </span>
          <span className="col-start-1 row-start-1 truncate font-medium md:col-auto md:row-auto">
            {commit.message.split("\n", 1)[0]}
          </span>
          <span className="col-span-2 row-start-3 truncate text-muted-foreground md:col-span-1 md:row-auto">
            {commit.author}
          </span>
          <span className="col-start-2 row-start-1 whitespace-nowrap text-right text-[10px] text-muted-foreground md:col-auto md:row-auto md:text-xs">
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

function Checks({
  detail,
  onOpenActionsRun,
  onSummarize,
  summarizing,
}: {
  detail: GithubPullRequestChecks;
  onOpenActionsRun(target: GithubActionsTarget): void;
  onSummarize(): void;
  summarizing: boolean;
}) {
  const failureCount = detail.checks.filter(isFailedPullRequestCheck).length;
  return (
    <div className="overflow-y-auto">
      <DataWarnings warnings={detail.warnings} />
      {failureCount ? (
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-4 py-2 backdrop-blur">
          <p className="text-xs text-muted-foreground">
            {failureCount} failed check{failureCount === 1 ? "" : "s"}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={summarizing}
            onClick={onSummarize}
          >
            {summarizing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Summarize failures
          </Button>
        </div>
      ) : null}
      {detail.checksTruncated ? (
        <TruncatedNotice>
          Showing the first 200 check and status results.
        </TruncatedNotice>
      ) : null}
      {detail.checks.map((check) => {
        const actionsTarget = parseGithubActionsUrl(check.url);
        return (
          <article
            key={`${check.source}:${check.id}`}
            className="flex min-h-12 items-start gap-3 px-4 py-3 odd:bg-muted/[0.035]"
          >
            <CheckIcon check={check} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{check.name}</p>
              <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                {pullRequestCheckLabel(check)} ·{" "}
                {check.source.replace("-", " ")}
              </p>
              {check.summary ? (
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
                  {check.summary}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {actionsTarget ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => onOpenActionsRun(actionsTarget)}
                >
                  View in Actions
                </Button>
              ) : null}
              {check.url ? (
                <Button variant="ghost" size="icon" className="size-7" asChild>
                  <a href={check.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    <span className="sr-only">
                      Open check details on GitHub
                    </span>
                  </a>
                </Button>
              ) : null}
            </div>
          </article>
        );
      })}
      {detail.checks.length === 0 ? (
        <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
          No checks reported for this commit.
        </div>
      ) : null}
    </div>
  );
}

function GithubAgentCleanupDialog({
  chatIds,
  onCleanup,
  onOpenChange,
  open,
  worktrees,
}: {
  chatIds: string[];
  onCleanup(input: GithubAgentWorkflowCleanupInput): Promise<void>;
  onOpenChange(open: boolean): void;
  open: boolean;
  worktrees: Array<{ id: string; branch: string | null }>;
}) {
  const [deleteBranches, setDeleteBranches] = useState(false);
  const branches = [
    ...new Set(worktrees.flatMap(({ branch }) => (branch ? [branch] : []))),
  ];
  const cleanup = useMutation({
    mutationFn: () =>
      onCleanup({
        chatIds,
        deleteBranches,
        worktrees,
      }),
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && cleanup.isPending) return;
        if (!next) setDeleteBranches(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clean up merged pull request</DialogTitle>
          <DialogDescription>
            Archive the linked agent {chatIds.length === 1 ? "chat" : "chats"}
            {worktrees.length > 0
              ? ` and remove ${worktrees.length === 1 ? "its clean worktree" : `${worktrees.length} clean worktrees`}`
              : ""}
            . Dirty worktrees are preserved and will make cleanup stop with an
            error.
          </DialogDescription>
        </DialogHeader>
        {branches.length > 0 ? (
          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <input
              checked={deleteBranches}
              className="mt-0.5 size-4 accent-primary"
              disabled={cleanup.isPending}
              type="checkbox"
              onChange={(event) => setDeleteBranches(event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                Delete local {branches.length === 1 ? "branch" : "branches"}
              </span>
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                {branches.join(", ")}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                This is optional and uses Cantrip&apos;s reviewed branch
                operation.
              </span>
            </span>
          </label>
        ) : null}
        {cleanup.isError ? (
          <p className="text-sm text-destructive">
            {cleanup.error instanceof Error
              ? cleanup.error.message
              : "Cleanup failed."}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={cleanup.isPending}
            onClick={() => onOpenChange(false)}
          >
            Keep for now
          </Button>
          <Button disabled={cleanup.isPending} onClick={() => cleanup.mutate()}>
            {cleanup.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            Archive and clean up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GithubPullRequestDialog({
  chats,
  onCleanupAgentWorkflow,
  onCheckedOut,
  onOpenActionsRun,
  onOpenChange,
  onStartAgent,
  projectId,
  pullRequestNumber,
  worktreeId,
  worktrees,
}: {
  chats: ChatSummary[];
  onCleanupAgentWorkflow(input: GithubAgentWorkflowCleanupInput): Promise<void>;
  onCheckedOut(worktreeId: string): void;
  onOpenActionsRun(target: GithubActionsTarget): void;
  onOpenChange(open: boolean): void;
  onStartAgent(
    pullRequestNumber: number,
    intent: GithubPullRequestAgentContextRequest["intent"],
  ): Promise<void>;
  projectId: string;
  pullRequestNumber: number | null;
  worktreeId: string;
  worktrees: ProjectWorktreeSummary[];
}) {
  const [tab, setTab] = useState<PullRequestTab>("overview");
  const [lifecycleAction, setLifecycleAction] =
    useState<GithubPullRequestLifecycleAction | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const queryClient = useQueryClient();
  const pullRequestKey = [
    "github-pull-request",
    projectId,
    worktreeId,
    pullRequestNumber,
  ];
  const overviewKey = [...pullRequestKey, "overview"];
  const overview = useQuery({
    enabled: pullRequestNumber !== null,
    queryKey: overviewKey,
    queryFn: () =>
      getGithubPullRequestOverview(projectId, worktreeId, pullRequestNumber!),
  });
  const files = useQuery({
    enabled: pullRequestNumber !== null && tab === "files",
    queryKey: [...pullRequestKey, "files"],
    queryFn: () =>
      getGithubPullRequestFiles(projectId, worktreeId, pullRequestNumber!),
  });
  const commits = useQuery({
    enabled: pullRequestNumber !== null && tab === "commits",
    queryKey: [...pullRequestKey, "commits"],
    queryFn: () =>
      getGithubPullRequestCommits(projectId, worktreeId, pullRequestNumber!),
  });
  const checks = useQuery({
    enabled: pullRequestNumber !== null && tab === "checks",
    queryKey: [...pullRequestKey, "checks"],
    queryFn: () =>
      getGithubPullRequestChecks(projectId, worktreeId, pullRequestNumber!),
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
      queryClient.setQueryData(overviewKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pullRequestKey }),
        queryClient.invalidateQueries({
          queryKey: ["github-issues", projectId, "pull-request"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["github-inbox", projectId, "pull-request"],
        }),
      ]);
    },
  });
  const checkout = useMutation({
    mutationFn: () =>
      checkoutGithubPullRequest(projectId, worktreeId, pullRequestNumber!),
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", projectId],
        (current = []) => mergeCheckedOutWorktree(current, result.worktree),
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-status", projectId],
      });
      onCheckedOut(result.worktree.id);
    },
  });
  const failedCheckSummary = useMutation({
    mutationFn: () =>
      generateProjectWorktreeGitDraft(projectId, worktreeId, {
        task: "summarize-failed-checks",
        instructions: null,
        baseRevision: null,
        headRevision: null,
        pullRequestNumber,
      }),
  });
  const startAgent = useMutation({
    mutationFn: (intent: GithubPullRequestAgentContextRequest["intent"]) =>
      onStartAgent(pullRequestNumber!, intent),
  });
  useEffect(() => {
    setTab("overview");
    setLifecycleAction(null);
    setAgentOpen(false);
    setCleanupOpen(false);
    startAgent.reset();
    failedCheckSummary.reset();
  }, [pullRequestNumber]);

  const relatedChats = chats.filter(
    ({ githubAgentContext }) =>
      githubAgentContext?.kind === "pull-request" &&
      githubAgentContext.number === pullRequestNumber,
  );
  const relatedWorktrees = worktrees.filter(
    ({ branch, id, isPrimary }) =>
      !isPrimary &&
      (relatedChats.some(({ activeWorktreeId }) => activeWorktreeId === id) ||
        branch?.startsWith(`cantrip/pr/${pullRequestNumber}-`)),
  );

  return (
    <>
      <Dialog open={pullRequestNumber !== null} onOpenChange={onOpenChange}>
        <DialogContent
          className={`${gitMobileInspectorClassName} flex flex-col md:h-[min(90svh,900px)] md:w-[min(96vw,1200px)]`}
          showClose={false}
        >
          <GitMobileInspectorClose label="Back to pull requests" />
          {overview.data ? (
            <DialogHeader className="shrink-0 border-b pb-4 pl-14 pr-4 pt-[max(1rem,env(safe-area-inset-top))] md:px-5 md:py-4 md:pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={overview.data.merged ? "default" : "secondary"}>
                  {overview.data.merged
                    ? "merged"
                    : overview.data.draft
                      ? "draft"
                      : overview.data.state}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  #{overview.data.number}
                </span>
                <span className="text-xs text-muted-foreground">
                  {overview.data.headRef} → {overview.data.baseRef}
                </span>
              </div>
              <div className="mt-1 flex flex-col gap-3 md:flex-row md:items-start">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="line-clamp-2 text-left text-lg md:truncate">
                    {overview.data.title}
                  </DialogTitle>
                  <DialogDescription className="text-left">
                    @{overview.data.author} · {overview.data.commitCount}{" "}
                    commits · {overview.data.changedFileCount} files
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 flex-wrap justify-start gap-1.5 md:justify-end">
                  {!overview.data.merged ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={startAgent.isPending}
                      onClick={() => startAgent.mutate("address-review")}
                    >
                      {startAgent.isPending &&
                      startAgent.variables === "address-review" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Bot className="size-3.5" />
                      )}
                      Address review
                    </Button>
                  ) : null}
                  {!overview.data.merged &&
                  (overview.data.checksState === "failure" ||
                    checks.data?.checks.some(isFailedPullRequestCheck)) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={startAgent.isPending}
                      onClick={() => startAgent.mutate("fix-checks")}
                    >
                      {startAgent.isPending &&
                      startAgent.variables === "fix-checks" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="size-3.5" />
                      )}
                      Fix checks
                    </Button>
                  ) : null}
                  {overview.data.merged &&
                  (relatedChats.length > 0 || relatedWorktrees.length > 0) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCleanupOpen(true)}
                    >
                      <Archive className="size-3.5" /> Cleanup
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate()}
                  >
                    {checkout.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <GitBranch className="size-3.5" />
                    )}
                    Checkout
                  </Button>
                  {overview.data.state === "open" && overview.data.draft ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setLifecycleAction({ type: "mark-ready" })}
                    >
                      Ready
                    </Button>
                  ) : null}
                  {overview.data.state === "open" &&
                  !overview.data.draft &&
                  !overview.data.merged ? (
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
                  {overview.data.state === "open" && !overview.data.merged ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => setLifecycleAction({ type: "close" })}
                    >
                      Close
                    </Button>
                  ) : null}
                  {overview.data.state === "closed" && !overview.data.merged ? (
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
                      href={overview.data.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="size-3.5" /> GitHub
                    </a>
                  </Button>
                </div>
              </div>
              {checkout.error ? (
                <p className="mt-2 text-left text-xs text-destructive">
                  {checkout.error instanceof Error
                    ? checkout.error.message
                    : "Pull request checkout failed."}
                </p>
              ) : null}
              {startAgent.error ? (
                <p className="mt-2 text-left text-xs text-destructive">
                  {startAgent.error instanceof Error
                    ? startAgent.error.message
                    : "The agent workflow could not be started."}
                </p>
              ) : null}
            </DialogHeader>
          ) : (
            <DialogHeader className="shrink-0 border-b p-4 pl-14 pt-[max(1rem,env(safe-area-inset-top))] md:p-6 md:pr-12">
              <DialogTitle>Pull request #{pullRequestNumber}</DialogTitle>
              <DialogDescription>
                {overview.isLoading
                  ? "Loading overview…"
                  : "The overview is unavailable. Other sections can still be opened."}
              </DialogDescription>
            </DialogHeader>
          )}
          <div className="flex h-9 min-w-0 shrink-0 items-end gap-1 overflow-x-auto overflow-y-hidden border-b px-3 overscroll-x-contain">
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
                {value === "files" && overview.data
                  ? ` ${overview.data.changedFileCount}`
                  : ""}
                {value === "commits" && overview.data
                  ? ` ${overview.data.commitCount}`
                  : ""}
                {value === "checks" && checks.data
                  ? ` ${checks.data.checks.length}`
                  : ""}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {tab === "overview" ? (
              overview.data ? (
                <Overview
                  detail={{
                    ...overview.data,
                    checksState:
                      checks.data?.checksState ?? overview.data.checksState,
                  }}
                  error={action.error}
                  pending={action.isPending}
                  onAction={async (input) => {
                    await action.mutateAsync(input);
                  }}
                />
              ) : (
                <SectionState
                  error={overview.error}
                  loading={overview.isLoading}
                  onRetry={() => void overview.refetch()}
                />
              )
            ) : null}
            {tab === "files" ? (
              files.data ? (
                <PullRequestFiles
                  detail={files.data}
                  error={action.error}
                  pending={action.isPending}
                  reviewThreads={overview.data?.reviewThreads}
                  onAction={async (input) => {
                    await action.mutateAsync(input);
                  }}
                />
              ) : (
                <SectionState
                  error={files.error}
                  loading={files.isLoading}
                  onRetry={() => void files.refetch()}
                />
              )
            ) : null}
            {tab === "commits" ? (
              commits.data ? (
                <Commits detail={commits.data} />
              ) : (
                <SectionState
                  error={commits.error}
                  loading={commits.isLoading}
                  onRetry={() => void commits.refetch()}
                />
              )
            ) : null}
            {tab === "checks" ? (
              checks.data ? (
                <Checks
                  detail={checks.data}
                  onOpenActionsRun={onOpenActionsRun}
                  summarizing={failedCheckSummary.isPending}
                  onSummarize={() => {
                    setAgentOpen(true);
                    failedCheckSummary.mutate();
                  }}
                />
              ) : (
                <SectionState
                  error={checks.error}
                  loading={checks.isLoading}
                  onRetry={() => void checks.refetch()}
                />
              )
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <GitAgentDraftDialog
        draft={failedCheckSummary.data ?? null}
        error={
          failedCheckSummary.error instanceof Error
            ? failedCheckSummary.error.message
            : null
        }
        loading={failedCheckSummary.isPending}
        onOpenChange={setAgentOpen}
        onRegenerate={() => failedCheckSummary.mutate()}
        open={agentOpen}
        task="summarize-failed-checks"
      />
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
            queryClient.setQueryData(overviewKey, updated);
            void queryClient.invalidateQueries({ queryKey: pullRequestKey });
            void queryClient.invalidateQueries({
              queryKey: ["github-issues", projectId, "pull-request"],
            });
            void queryClient.invalidateQueries({
              queryKey: ["github-inbox", projectId, "pull-request"],
            });
            if (
              updated.merged &&
              (relatedChats.length || relatedWorktrees.length)
            ) {
              setCleanupOpen(true);
            }
          }}
        />
      ) : null}
      <GithubAgentCleanupDialog
        chatIds={relatedChats.map(({ id }) => id)}
        onCleanup={onCleanupAgentWorkflow}
        onOpenChange={setCleanupOpen}
        open={cleanupOpen}
        worktrees={relatedWorktrees.map(({ id, branch }) => ({ id, branch }))}
      />
    </>
  );
}
