import {
  githubIssueListFiltersSchema,
  type ChatSummary,
  type GitStatus,
  type GithubIssueDetail,
  type GithubInboxAttention,
  type GithubInboxItem,
  type GithubInboxList,
  type GithubInboxView,
  type GithubIssueKind,
  type GithubIssueListFilters,
  type GithubIssueState,
  type GithubIssueSummary,
  type GithubPullRequestAgentContextRequest,
  type GithubPullRequestSummary,
  type ProjectSummary,
  type ProjectWorktreeSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellDot,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDotDashed,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequestDraft,
  Inbox,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
  Filter,
  Loader2,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import { GitContentSurface } from "./git-content-surface";
import {
  GitMobileInspectorClose,
  gitMobileInspectorClassName,
} from "./git-mobile-inspector";
import {
  githubInboxAttentionLabels,
  githubInboxViews,
  visibleGithubInboxAttention,
} from "./github-inbox";
import { GithubIssueCreateDialog } from "./github-issue-create-dialog";
import { GithubPullRequestCreateDialog } from "./github-pull-request-create-dialog";
import { GithubPullRequestDialog } from "./github-pull-request-dialog";
import type { GithubActionsTarget } from "./github-actions-model";
import type { GithubAgentWorkflowCleanupInput } from "./github-agent-workflow";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const defaultGithubListFilters = githubIssueListFiltersSchema.parse({});

function isPullRequest(
  item: GithubInboxItem | GithubIssueSummary | GithubPullRequestSummary,
): item is GithubPullRequestSummary {
  return "headRef" in item;
}

function activeFilterCount(filters: GithubIssueListFilters): number {
  return [
    filters.labels.length > 0,
    filters.author !== null,
    filters.assignee !== null,
    filters.milestone !== null,
    filters.draft !== null,
    filters.reviewDecision !== null,
    filters.mergeability !== null,
    filters.checksState !== null,
  ].filter(Boolean).length;
}

function errorText(error: unknown): string {
  return errorMessage(error, "GitHub request failed.");
}

export function GithubIssueMobileCard({
  issue,
  onSelect,
}: {
  issue: GithubInboxItem | GithubIssueSummary | GithubPullRequestSummary;
  onSelect(): void;
}) {
  const inboxIssue = "attention" in issue ? issue : null;
  const attention = inboxIssue ? visibleGithubInboxAttention(inboxIssue) : [];
  return (
    <button
      type="button"
      data-high-contrast-row
      onClick={onSelect}
      className="grid min-h-20 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 overflow-hidden px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium leading-5">
          {issue.title}
        </span>
        {issue.labels.length ? (
          <span className="mt-2 flex min-w-0 flex-wrap gap-1">
            {issue.labels.slice(0, 3).map((label) => (
              <span
                key={label.name}
                className="max-w-28 truncate rounded-full border px-1.5 py-0.5 text-[9px]"
                style={{ borderColor: `#${label.color}80` }}
              >
                {label.name}
              </span>
            ))}
            {issue.labels.length > 3 ? (
              <span className="text-[10px] text-muted-foreground">
                +{issue.labels.length - 3}
              </span>
            ) : null}
          </span>
        ) : null}
        {inboxIssue?.pullRequest ? (
          <span className="mt-2 flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{inboxIssue.pullRequest.headRef}</span>
            <span>→</span>
            <span className="truncate">{inboxIssue.pullRequest.baseRef}</span>
          </span>
        ) : null}
        {inboxIssue?.pullRequest ? (
          <span className="mt-2 block">
            <PullRequestState item={inboxIssue} />
          </span>
        ) : null}
        {attention.length ? (
          <span className="mt-2 flex min-w-0 flex-wrap gap-1">
            {attention.slice(0, 4).map((value) => (
              <AttentionPill key={value} attention={value} />
            ))}
          </span>
        ) : null}
      </span>
      <ChevronRight className="mt-0.5 size-4 text-muted-foreground" />
      <span className="col-span-2 flex min-w-0 items-center gap-2 overflow-hidden text-[10px] text-muted-foreground">
        <span className="flex shrink-0 items-center gap-1.5 font-mono">
          {inboxIssue?.attention.includes("unread") ? (
            <span
              className="size-1.5 rounded-full bg-blue-500"
              aria-label="Unread activity"
            />
          ) : null}
          #{issue.number}
        </span>
        <span className="min-w-0 truncate">@{issue.author}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <MessageSquare className="size-3" /> {issue.commentCount}
        </span>
        <span className="shrink-0">
          {dateFormatter.format(new Date(issue.updatedAt))}
        </span>
      </span>
    </button>
  );
}

function attentionTone(attention: GithubInboxAttention): string {
  switch (attention) {
    case "failed-checks":
    case "merge-conflict":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "approved-ready":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "review-requested":
    case "mention":
    case "unread":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "assigned":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "stale":
      return "border-border bg-muted/50 text-muted-foreground";
  }
}

function AttentionPill({ attention }: { attention: GithubInboxAttention }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-1.5 text-[9px] font-medium",
        attentionTone(attention),
      )}
    >
      {githubInboxAttentionLabels[attention]}
    </span>
  );
}

function PullRequestState({
  item,
}: {
  item: GithubInboxList["items"][number];
}) {
  const pullRequest = item.pullRequest;
  if (!pullRequest) return null;
  const review =
    pullRequest.reviewDecision === "approved"
      ? {
          label: "Approved",
          className: "text-emerald-600 dark:text-emerald-300",
        }
      : pullRequest.reviewDecision === "changes-requested"
        ? { label: "Changes requested", className: "text-destructive" }
        : pullRequest.reviewDecision === "review-required"
          ? {
              label: "Review required",
              className: "text-amber-600 dark:text-amber-300",
            }
          : { label: "No review", className: "text-muted-foreground" };
  const checks =
    pullRequest.checksState === "success"
      ? {
          label: "Checks passed",
          className: "text-emerald-600 dark:text-emerald-300",
        }
      : pullRequest.checksState === "failure"
        ? { label: "Checks failed", className: "text-destructive" }
        : pullRequest.checksState === "pending"
          ? {
              label: "Checks pending",
              className: "text-amber-600 dark:text-amber-300",
            }
          : pullRequest.checksState === "none"
            ? { label: "No checks", className: "text-muted-foreground" }
            : { label: "Checks neutral", className: "text-muted-foreground" };
  const merge =
    pullRequest.mergeable === "mergeable"
      ? {
          label: "Mergeable",
          icon: GitMerge,
          className: "text-muted-foreground",
        }
      : pullRequest.mergeable === "conflicting"
        ? { label: "Conflict", icon: XCircle, className: "text-destructive" }
        : {
            label: "Merge pending",
            icon: CircleDotDashed,
            className: "text-muted-foreground",
          };
  const MergeIcon = merge.icon;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {pullRequest.draft ? (
          <GitPullRequestDraft className="size-3" />
        ) : (
          <ShieldCheck className="size-3" />
        )}
        {pullRequest.draft ? "Draft" : "Ready"}
      </span>
      <span className={review.className}>{review.label}</span>
      <span className={checks.className}>{checks.label}</span>
      <span className={cn("inline-flex items-center gap-1", merge.className)}>
        <MergeIcon className="size-3" /> {merge.label}
      </span>
    </span>
  );
}

function IssueDialog({
  issueNumber,
  kind,
  linkedChat,
  onStartAgent,
  onOpenChange,
  project,
}: {
  issueNumber: number | null;
  kind: GithubIssueKind;
  linkedChat: ChatSummary | null;
  onStartAgent(issue: GithubIssueDetail): Promise<void>;
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
        queryKey: ["github-issues", project.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["github-inbox", project.id],
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
  const startAgent = useMutation({ mutationFn: onStartAgent });
  const pending = comment.isPending || close.isPending || startAgent.isPending;

  return (
    <Dialog
      open={issueNumber !== null}
      onOpenChange={(open) => {
        if (!open) setDraft("");
        onOpenChange(open);
      }}
    >
      <DialogContent
        className={`${gitMobileInspectorClassName} flex flex-col md:max-w-3xl`}
        showClose={false}
      >
        <GitMobileInspectorClose label="Back to issues" />
        {issue.isLoading ? (
          <div className="grid min-h-80 place-items-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : issue.isError || !issue.data ? (
          <div className="p-4 pt-[max(4rem,env(safe-area-inset-top))] md:p-6">
            <DialogHeader className="pr-0 md:pr-8">
              <DialogTitle>
                {`${kind === "pull-request" ? "Pull request" : "Issue"} could not be loaded`}
              </DialogTitle>
              <DialogDescription>{errorText(issue.error)}</DialogDescription>
            </DialogHeader>
          </div>
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b pb-4 pl-14 pr-4 pt-[max(1rem,env(safe-area-inset-top))] md:px-6 md:py-5 md:pr-12">
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

            <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-4 py-5 md:px-6">
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
                {comment.isError || close.isError || startAgent.isError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {errorText(
                      comment.error ?? close.error ?? startAgent.error,
                    )}
                  </p>
                ) : null}
              </section>
            </div>

            <DialogFooter className="shrink-0 border-t bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:justify-between md:px-6 md:py-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" asChild>
                  <a href={issue.data.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" />
                    Open in GitHub
                  </a>
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => startAgent.mutate(issue.data)}
                >
                  {startAgent.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Bot className="size-4" />
                  )}
                  {linkedChat ? "Open agent" : "Start work"}
                </Button>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {issue.data.state === "open" && kind === "issue" ? (
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
  chats,
  error,
  filters,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  inbox,
  items,
  kind,
  onFiltersChange,
  onLoadMore,
  onOpenActionsRun,
  onCleanupAgentWorkflow,
  onStartIssueAgent,
  onStartPullRequestAgent,
  onViewChange,
  onSelectWorktree,
  project,
  status,
  state,
  worktreeId,
  worktrees,
  view,
}: {
  chats: ChatSummary[];
  error: unknown;
  filters: GithubIssueListFilters;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  inbox: GithubInboxList | undefined;
  items:
    | Array<GithubInboxItem | GithubIssueSummary | GithubPullRequestSummary>
    | undefined;
  kind: GithubIssueKind;
  onFiltersChange(filters: GithubIssueListFilters): void;
  onLoadMore(): void;
  onOpenActionsRun(target: GithubActionsTarget): void;
  onCleanupAgentWorkflow(input: GithubAgentWorkflowCleanupInput): Promise<void>;
  onStartIssueAgent(issue: GithubIssueDetail): Promise<void>;
  onStartPullRequestAgent(
    pullRequestNumber: number,
    intent: GithubPullRequestAgentContextRequest["intent"],
  ): Promise<void>;
  onViewChange(view: GithubInboxView): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSummary;
  status: GitStatus | undefined;
  state: GithubIssueState;
  worktreeId: string;
  worktrees: ProjectWorktreeSummary[];
  view: GithubInboxView;
}) {
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] =
    useState<GithubIssueListFilters>(filters);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const itemLabel = kind === "pull-request" ? "pull requests" : "issues";
  const filterCount = activeFilterCount(filters);
  const filterDraftValid = useMemo(
    () => githubIssueListFiltersSchema.safeParse(filterDraft).success,
    [filterDraft],
  );

  useEffect(() => setSearchDraft(filters.search), [filters.search]);

  useEffect(() => {
    if (searchDraft === filters.search) return;
    const timeout = window.setTimeout(
      () => onFiltersChange({ ...filters, search: searchDraft.trim() }),
      350,
    );
    return () => window.clearTimeout(timeout);
  }, [filters, onFiltersChange, searchDraft]);
  const views = githubInboxViews(kind, state);
  const activeView = views.find(({ id }) => id === view) ?? views[0]!;
  const displayItems = inbox?.items ?? items;

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
    <GitContentSurface className="flex flex-col" guttered>
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b px-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label={`${kind === "pull-request" ? "Pull request" : "Issue"} saved views`}
        >
          {views.map((savedView) => (
            <Button
              key={savedView.id}
              type="button"
              size="sm"
              variant={view === savedView.id ? "outline" : "ghost"}
              className="h-7 shrink-0 rounded-full px-2.5 text-[10px]"
              title={savedView.description}
              aria-pressed={view === savedView.id}
              onClick={() => onViewChange(savedView.id)}
            >
              {savedView.id === "activity" ? (
                <BellDot className="size-3" />
              ) : savedView.id === "assigned-to-me" ? (
                <UserRoundCheck className="size-3" />
              ) : savedView.id === "failed-checks" ||
                savedView.id === "merge-conflicts" ? (
                <CircleAlert className="size-3" />
              ) : savedView.id === "approved-ready" ? (
                <CheckCircle2 className="size-3" />
              ) : savedView.id === "needs-review" ? (
                <MessageSquare className="size-3" />
              ) : (
                <Inbox className="size-3" />
              )}
              {savedView.label}
            </Button>
          ))}
        </div>
        {inbox ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {inbox.total === null
              ? `${inbox.items.length} loaded`
              : inbox.total}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <div className="relative min-w-44 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`Search ${itemLabel}`}
            className="h-8 pl-8 text-xs"
            disabled={view !== "all"}
            placeholder={`Search ${itemLabel}…`}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </div>
        <NativeSelect
          aria-label={`${kind === "pull-request" ? "Pull request" : "Issue"} view`}
          className="max-w-40"
          disabled={view !== "all"}
          size="sm"
          value={filters.view}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              view: event.target.value as GithubIssueListFilters["view"],
            })
          }
        >
          <option value="all">All</option>
          <option value="assigned-to-me">Assigned to me</option>
          {kind === "pull-request" ? (
            <option value="review-requested">Review requested</option>
          ) : null}
          <option value="recently-updated">Recently updated</option>
        </NativeSelect>
        <Popover
          open={filtersOpen}
          onOpenChange={(open) => {
            setFiltersOpen(open);
            if (open) setFilterDraft(filters);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              disabled={view !== "all"}
            >
              <Filter className="size-3.5" />
              Filters{filterCount ? ` ${filterCount}` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(92vw,420px)] space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs">
                Author
                <Input
                  className="h-8 text-xs"
                  placeholder="octocat or @me"
                  value={filterDraft.author ?? ""}
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      author: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs">
                Assignee
                <Input
                  className="h-8 text-xs"
                  placeholder="octocat or @me"
                  value={filterDraft.assignee ?? ""}
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      assignee: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs">
                Milestone
                <Input
                  className="h-8 text-xs"
                  placeholder="Milestone title"
                  value={filterDraft.milestone ?? ""}
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      milestone: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="grid gap-1 text-xs">
                Labels
                <Input
                  className="h-8 text-xs"
                  placeholder="bug, priority"
                  value={filterDraft.labels.join(", ")}
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      labels: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    }))
                  }
                />
              </label>
              {kind === "pull-request" ? (
                <>
                  <label className="grid gap-1 text-xs">
                    Draft
                    <NativeSelect
                      size="sm"
                      value={
                        filterDraft.draft === null
                          ? "all"
                          : String(filterDraft.draft)
                      }
                      onChange={(event) =>
                        setFilterDraft((current) => ({
                          ...current,
                          draft:
                            event.target.value === "all"
                              ? null
                              : event.target.value === "true",
                        }))
                      }
                    >
                      <option value="all">All</option>
                      <option value="false">Ready</option>
                      <option value="true">Draft</option>
                    </NativeSelect>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Review decision
                    <NativeSelect
                      size="sm"
                      value={filterDraft.reviewDecision ?? "all"}
                      onChange={(event) =>
                        setFilterDraft((current) => ({
                          ...current,
                          reviewDecision:
                            event.target.value === "all"
                              ? null
                              : (event.target
                                  .value as GithubIssueListFilters["reviewDecision"]),
                        }))
                      }
                    >
                      <option value="all">All</option>
                      <option value="approved">Approved</option>
                      <option value="changes-requested">
                        Changes requested
                      </option>
                      <option value="review-required">Review required</option>
                      <option value="none">No review</option>
                    </NativeSelect>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Mergeability
                    <NativeSelect
                      size="sm"
                      value={filterDraft.mergeability ?? "all"}
                      onChange={(event) =>
                        setFilterDraft((current) => ({
                          ...current,
                          mergeability:
                            event.target.value === "all"
                              ? null
                              : (event.target
                                  .value as GithubIssueListFilters["mergeability"]),
                        }))
                      }
                    >
                      <option value="all">All</option>
                      <option value="mergeable">Mergeable</option>
                      <option value="conflicting">Conflicting</option>
                      <option value="unknown">Calculating</option>
                    </NativeSelect>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Checks
                    <NativeSelect
                      size="sm"
                      value={filterDraft.checksState ?? "all"}
                      onChange={(event) =>
                        setFilterDraft((current) => ({
                          ...current,
                          checksState:
                            event.target.value === "all"
                              ? null
                              : (event.target
                                  .value as GithubIssueListFilters["checksState"]),
                        }))
                      }
                    >
                      <option value="all">All</option>
                      <option value="success">Passing</option>
                      <option value="failure">Failing</option>
                      <option value="pending">Pending</option>
                    </NativeSelect>
                  </label>
                </>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const cleared = {
                    ...defaultGithubListFilters,
                    search: filters.search,
                  };
                  setFilterDraft(cleared);
                  onFiltersChange(cleared);
                  setFiltersOpen(false);
                }}
              >
                Clear
              </Button>
              <Button
                size="sm"
                disabled={!filterDraftValid}
                onClick={() => {
                  const parsed = githubIssueListFiltersSchema.safeParse({
                    ...filterDraft,
                    search: filters.search,
                  });
                  if (!parsed.success) return;
                  onFiltersChange(parsed.data);
                  setFiltersOpen(false);
                }}
              >
                Apply filters
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={kind === "pull-request" && !status?.branch}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5" />
          {kind === "pull-request" ? "Pull request" : "Issue"}
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
        ) : !displayItems?.length ? (
          <div className="grid min-h-64 place-items-center text-center">
            <div>
              <CheckCircle2 className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 font-medium">
                No {state} {itemLabel} in {activeView.label.toLowerCase()}
              </p>
              {view === "activity" && inbox && !inbox.activityAvailable ? (
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  GitHub notification access is unavailable. Mention search is
                  still active.
                </p>
              ) : null}
              {hasNextPage ? (
                <div ref={loadMoreRef}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    disabled={isFetchingNextPage}
                    onClick={onLoadMore}
                  >
                    {isFetchingNextPage ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Load more
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <div className="divide-y py-2 md:hidden">
              {displayItems.map((issue) => (
                <GithubIssueMobileCard
                  key={issue.number}
                  issue={issue}
                  onSelect={() => setSelectedIssue(issue.number)}
                />
              ))}
            </div>
            <div className="hidden min-w-[980px] py-2 text-xs md:block">
              <div
                data-slot="table-header-surface"
                className="sticky top-0 z-10 grid h-7 grid-cols-[70px_minmax(320px,1fr)_280px_140px_80px_110px] items-center border-y bg-muted/95 px-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur"
              >
                <span>{kind === "pull-request" ? "PR" : "Issue"}</span>
                <span>Title</span>
                <span>Status</span>
                <span>People</span>
                <span>Comments</span>
                <span className="text-right">Updated</span>
              </div>
              {displayItems.map((issue) => {
                const inboxIssue = "attention" in issue ? issue : null;
                const attention = inboxIssue
                  ? visibleGithubInboxAttention(inboxIssue)
                  : [];
                return (
                  <button
                    key={issue.number}
                    type="button"
                    data-high-contrast-row
                    onClick={() => setSelectedIssue(issue.number)}
                    className="grid min-h-16 w-full grid-cols-[70px_minmax(320px,1fr)_280px_140px_80px_110px] items-center px-4 py-2 text-left odd:bg-muted/[0.035] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex items-center gap-2 font-mono text-muted-foreground">
                      {inboxIssue?.attention.includes("unread") ? (
                        <span
                          className="size-1.5 rounded-full bg-blue-500"
                          aria-label="Unread activity"
                        />
                      ) : null}
                      #{issue.number}
                    </span>
                    <span className="min-w-0 pr-4">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">
                          {issue.title}
                        </span>
                        {issue.labels.slice(0, 2).map((label) => (
                          <span
                            key={label.name}
                            className="max-w-24 shrink-0 truncate rounded-full border px-1.5 py-0.5 text-[9px]"
                            style={{ borderColor: `#${label.color}80` }}
                          >
                            {label.name}
                          </span>
                        ))}
                      </span>
                      {inboxIssue?.pullRequest || isPullRequest(issue) ? (
                        <span className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
                          <GitBranch className="size-3 shrink-0" />
                          <span className="truncate">
                            {inboxIssue?.pullRequest?.headRef ??
                              (isPullRequest(issue) ? issue.headRef : "")}
                          </span>
                          <span>→</span>
                          <span className="truncate">
                            {inboxIssue?.pullRequest?.baseRef ??
                              (isPullRequest(issue) ? issue.baseRef : "")}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 pr-3">
                      {inboxIssue?.pullRequest ? (
                        <span className="block">
                          <PullRequestState item={inboxIssue} />
                          {attention.length ? (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {attention.slice(0, 4).map((value) => (
                                <AttentionPill key={value} attention={value} />
                              ))}
                            </span>
                          ) : null}
                        </span>
                      ) : isPullRequest(issue) ? (
                        <span className="flex flex-wrap gap-1">
                          {issue.draft ? (
                            <span className="rounded-full border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                              Draft
                            </span>
                          ) : null}
                          {issue.reviewDecision !== "none" ? (
                            <span className="rounded-full border px-1.5 py-0.5 text-[9px] capitalize text-muted-foreground">
                              {issue.reviewDecision.replace("-", " ")}
                            </span>
                          ) : null}
                          {issue.checksState !== "none" ? (
                            <span
                              className={cn(
                                "rounded-full border px-1.5 py-0.5 text-[9px] capitalize",
                                issue.checksState === "success" &&
                                  "border-emerald-500/40 text-emerald-600",
                                issue.checksState === "failure" &&
                                  "border-destructive/40 text-destructive",
                                issue.checksState === "pending" &&
                                  "border-amber-500/40 text-amber-600",
                              )}
                            >
                              {issue.checksState}
                            </span>
                          ) : null}
                          {issue.mergeable === false ? (
                            <span className="rounded-full border border-destructive/40 px-1.5 py-0.5 text-[9px] text-destructive">
                              Conflicts
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {attention.slice(0, 4).map((value) => (
                            <AttentionPill key={value} attention={value} />
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 text-[10px] text-muted-foreground">
                      <span className="block truncate">@{issue.author}</span>
                      {issue.assignees.length ? (
                        <span className="mt-0.5 block truncate">
                          Assigned @{issue.assignees[0]}
                          {issue.assignees.length > 1
                            ? ` +${issue.assignees.length - 1}`
                            : ""}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <MessageSquare className="size-3" />
                      {issue.commentCount}
                    </span>
                    <span className="text-right text-[10px] text-muted-foreground">
                      {dateFormatter.format(new Date(issue.updatedAt))}
                    </span>
                  </button>
                );
              })}
            </div>
            {hasNextPage || isFetchingNextPage ? (
              <div
                ref={loadMoreRef}
                className="grid h-12 place-items-center text-xs text-muted-foreground"
              >
                {isFetchingNextPage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <span>Scroll to load more</span>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {kind === "pull-request" ? (
        <GithubPullRequestDialog
          chats={chats}
          pullRequestNumber={selectedIssue}
          projectId={project.id}
          worktreeId={worktreeId}
          worktrees={worktrees}
          onCleanupAgentWorkflow={onCleanupAgentWorkflow}
          onCheckedOut={onSelectWorktree}
          onOpenActionsRun={(target) => {
            setSelectedIssue(null);
            onOpenActionsRun(target);
          }}
          onOpenChange={(open) => {
            if (!open) setSelectedIssue(null);
          }}
          onStartAgent={onStartPullRequestAgent}
        />
      ) : (
        <IssueDialog
          issueNumber={selectedIssue}
          kind={kind}
          linkedChat={
            chats.find(
              ({ githubAgentContext }) =>
                githubAgentContext?.kind === "issue" &&
                githubAgentContext.number === selectedIssue,
            ) ?? null
          }
          onStartAgent={onStartIssueAgent}
          project={project}
          onOpenChange={(open) => {
            if (!open) setSelectedIssue(null);
          }}
        />
      )}
      {kind === "issue" ? (
        <GithubIssueCreateDialog
          open={createOpen}
          projectId={project.id}
          onOpenChange={setCreateOpen}
          onCreated={(issue) => {
            queryClient.setQueryData(
              ["github-issue", project.id, issue.number],
              issue,
            );
            void queryClient.invalidateQueries({
              queryKey: ["github-issues", project.id, "issue"],
            });
            void queryClient.invalidateQueries({
              queryKey: ["github-inbox", project.id, "issue"],
            });
            setSelectedIssue(issue.number);
          }}
        />
      ) : status ? (
        <GithubPullRequestCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          projectId={project.id}
          status={status}
          worktreeId={worktreeId}
          onCreated={(pullRequest) => {
            void queryClient.invalidateQueries({
              queryKey: ["github-issues", project.id, "pull-request"],
            });
            void queryClient.invalidateQueries({
              queryKey: ["github-inbox", project.id, "pull-request"],
            });
            queryClient.setQueryData(
              ["github-issue", project.id, pullRequest.number],
              undefined,
            );
          }}
        />
      ) : null}
    </GitContentSurface>
  );
}
