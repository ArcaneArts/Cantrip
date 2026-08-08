import type {
  GitCommit,
  GitRef,
  GithubIssueState,
  ProjectSummary,
} from "@cantrip/protocol";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  CircleDot,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Tag,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getGitHistory, getGithubIssues, getGitStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { GitChangesPanel } from "./git-changes-panel";
import { GithubIssuesView } from "./github-issues";

const laneColors = [
  "#22d3ee",
  "#a855f7",
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#f43f5e",
  "#8b5cf6",
  "#84cc16",
];
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

interface GraphRow {
  commit: GitCommit;
  edges: Array<{ color: string; from: number; to: number }>;
  introduced: boolean;
  lane: number;
  nodeColor: string;
  passthrough: Array<{ color: string; from: number; to: number }>;
}

function graphRows(commits: GitCommit[]): {
  maxLanes: number;
  rows: GraphRow[];
} {
  let lanes: string[] = [];
  const colors = new Map<string, string>();
  let colorIndex = 0;
  let maxLanes = 1;
  const colorFor = (hash: string) => {
    let color = colors.get(hash);
    if (!color) {
      color = laneColors[colorIndex++ % laneColors.length]!;
      colors.set(hash, color);
    }
    return color;
  };

  const rows = commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    const introduced = lane < 0;
    if (introduced) {
      lane = lanes.length;
      lanes.push(commit.hash);
    }
    const nodeColor = colorFor(commit.hash);
    const before = [...lanes];
    const next = before.filter((_, index) => index !== lane);
    for (const [parentIndex, parent] of commit.parents.entries()) {
      if (!next.includes(parent)) next.splice(lane + parentIndex, 0, parent);
      if (parentIndex === 0) colors.set(parent, colorFor(commit.hash));
      else colorFor(parent);
    }
    const passthrough = before.flatMap((hash, from) => {
      if (from === lane) return [];
      const to = next.indexOf(hash);
      return to < 0 ? [] : [{ from, to, color: colorFor(hash) }];
    });
    const edges = commit.parents.map((parent) => ({
      from: lane,
      to: next.indexOf(parent),
      color: colorFor(parent),
    }));
    lanes = next;
    maxLanes = Math.max(maxLanes, before.length, next.length);
    return { commit, edges, introduced, lane, nodeColor, passthrough };
  });
  return { maxLanes, rows };
}

function relativeDate(value: string): string {
  const delta = new Date(value).getTime() - Date.now();
  const hours = Math.round(delta / 3_600_000);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  const days = Math.round(delta / 86_400_000);
  if (Math.abs(days) < 30) return relativeTime.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return relativeTime.format(months, "month");
  return relativeTime.format(Math.round(days / 365), "year");
}

function RefLabel({ gitRef }: { gitRef: GitRef }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 max-w-24 items-center gap-0.5 rounded px-1 text-[9px] font-medium",
        gitRef.kind === "head" &&
          "bg-cyan-500/20 text-cyan-600 dark:text-cyan-300",
        gitRef.kind === "local" &&
          "bg-blue-500/20 text-blue-600 dark:text-blue-300",
        gitRef.kind === "remote" &&
          "bg-violet-500/20 text-violet-600 dark:text-violet-300",
        gitRef.kind === "tag" &&
          "bg-amber-500/20 text-amber-700 dark:text-amber-300",
        gitRef.current && "ring-1 ring-current",
      )}
      title={`${gitRef.kind} ref: ${gitRef.name}`}
    >
      {gitRef.kind === "tag" ? (
        <Tag className="size-2.5" />
      ) : (
        <GitBranch className="size-2.5" />
      )}
      <span className="truncate">{gitRef.name}</span>
    </span>
  );
}

function CommitGraph({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => 10 + lane * 16;
  return (
    <svg
      width={width}
      height="32"
      className="block overflow-visible"
      aria-hidden="true"
    >
      {!row.introduced ? (
        <path
          d={`M ${x(row.lane)} -1 L ${x(row.lane)} 16`}
          fill="none"
          stroke={row.nodeColor}
          strokeWidth="2"
        />
      ) : null}
      {row.passthrough.map((edge, index) => (
        <path
          key={`p:${index}`}
          d={`M ${x(edge.from)} -1 C ${x(edge.from)} 12, ${x(edge.to)} 20, ${x(edge.to)} 33`}
          fill="none"
          stroke={edge.color}
          strokeWidth="2"
        />
      ))}
      {row.edges.map((edge, index) => (
        <path
          key={`e:${index}`}
          d={`M ${x(edge.from)} 16 C ${x(edge.from)} 23, ${x(edge.to)} 24, ${x(edge.to)} 33`}
          fill="none"
          stroke={edge.color}
          strokeWidth="2"
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy="16"
        r={row.commit.isHead ? 5 : 4}
        fill="var(--background)"
        stroke={row.nodeColor}
        strokeWidth={row.commit.isHead ? 3 : 2}
      />
      {row.commit.isHead ? (
        <circle cx={x(row.lane)} cy="16" r="1.5" fill={row.nodeColor} />
      ) : null}
    </svg>
  );
}

export interface GitHistoryHeaderState {
  activeView: "commits" | "issues";
  branch: string;
  changesCount: number;
  changesOpen: boolean;
  commitsLoaded: number;
  head: string | null;
  isFetching: boolean;
  issueCount: number | null;
  issueState: GithubIssueState;
  refresh(): void;
  toggleChanges(): void;
}

export function GitHistoryView({
  initialView = "commits",
  onHeaderChange,
  project,
  standalone = false,
}: {
  initialView?: "commits" | "issues";
  onHeaderChange(state: GitHistoryHeaderState | null): void;
  project: ProjectSummary;
  standalone?: boolean;
}) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [activeView, setActiveView] = useState<"commits" | "issues">(
    initialView,
  );
  const [issueState, setIssueState] = useState<GithubIssueState>("open");
  const history = useInfiniteQuery({
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getGitHistory(project.id, pageParam),
    queryKey: ["git-history", project.id],
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const status = useQuery({
    queryFn: () => getGitStatus(project.id),
    queryKey: ["git-status", project.id],
    refetchInterval: 2_000,
  });
  const issues = useQuery({
    enabled: Boolean(project.github),
    queryFn: () => getGithubIssues(project.id, issueState),
    queryKey: ["github-issues", project.id, issueState],
  });
  const commits = useMemo(
    () => history.data?.pages.flatMap((page) => page.commits) ?? [],
    [history.data],
  );
  const graph = useMemo(() => graphRows(commits), [commits]);
  const graphWidth = Math.max(42, graph.maxLanes * 16 + 12);
  const graphAreaWidth = Math.min(220, Math.max(150, graphWidth + 108));
  const historyColumns = `${graphAreaWidth}px minmax(320px, 1fr) 150px 82px`;
  const firstPage = history.data?.pages[0];

  useEffect(() => {
    if (!firstPage) return;
    onHeaderChange({
      activeView,
      branch: firstPage.branch,
      changesCount: status.data?.files.length ?? 0,
      changesOpen,
      commitsLoaded: commits.length,
      head: firstPage.head,
      isFetching:
        activeView === "commits" ? history.isFetching : issues.isFetching,
      issueCount: issues.data?.total ?? null,
      issueState,
      refresh: () => {
        if (activeView === "commits") {
          void history.refetch();
          void status.refetch();
        } else {
          void issues.refetch();
        }
      },
      toggleChanges: () => setChangesOpen((open) => !open),
    });
  }, [
    activeView,
    changesOpen,
    commits.length,
    firstPage,
    history.isFetching,
    history.refetch,
    issueState,
    issues.data?.total,
    issues.isFetching,
    issues.refetch,
    onHeaderChange,
    status.data?.files.length,
    status.refetch,
  ]);

  useEffect(() => {
    return () => onHeaderChange(null);
  }, [onHeaderChange, project.id]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !history.hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !history.isFetchingNextPage) {
          void history.fetchNextPage();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-end gap-1 border-b px-4">
        <button
          type="button"
          onClick={() => setActiveView("commits")}
          className={cn(
            "flex h-10 items-center gap-2 border-b-2 px-3 text-sm text-muted-foreground",
            activeView === "commits"
              ? "border-foreground font-medium text-foreground"
              : "border-transparent hover:text-foreground",
          )}
        >
          <GitCommitHorizontal className="size-4" />
          Commits
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
            {firstPage?.totalCount ?? "…"}
          </span>
        </button>
        <button
          type="button"
          disabled={!project.github}
          onClick={() => setActiveView("issues")}
          className={cn(
            "flex h-10 items-center gap-2 border-b-2 px-3 text-sm text-muted-foreground disabled:opacity-40",
            activeView === "issues"
              ? "border-foreground font-medium text-foreground"
              : "border-transparent hover:text-foreground",
          )}
        >
          <CircleDot className="size-4" />
          Issues
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
            {issues.data?.total ?? (issues.isLoading ? "…" : 0)}
          </span>
        </button>
        {standalone && activeView === "commits" ? (
          <div className="ml-auto flex h-10 items-center gap-1">
            <Button
              size="sm"
              variant={changesOpen ? "outline" : "ghost"}
              onClick={() => setChangesOpen((open) => !open)}
              title="Show working changes"
            >
              <FileDiff className="size-4" />
              {status.data?.files.length ?? 0} changes
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              disabled={history.isFetching || status.isFetching}
              onClick={() => {
                void history.refetch();
                void status.refetch();
              }}
              title="Refresh Git history"
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  (history.isFetching || status.isFetching) && "animate-spin",
                )}
              />
              <span className="sr-only">Refresh Git history</span>
            </Button>
          </div>
        ) : null}
      </div>

      {activeView === "issues" ? (
        <GithubIssuesView
          error={issues.error}
          isFetching={issues.isFetching}
          isLoading={issues.isLoading}
          issues={issues.data}
          project={project}
          state={issueState}
          onRefresh={() => void issues.refetch()}
          onStateChange={setIssueState}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {history.isLoading ? (
              <div className="grid min-h-64 place-items-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : history.isError ? (
              <div className="m-5 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
                {history.error instanceof Error
                  ? history.error.message
                  : "Git history could not be loaded."}
              </div>
            ) : commits.length === 0 ? (
              <div className="grid min-h-64 place-items-center text-center">
                <div>
                  <GitCommitHorizontal className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-3 font-medium">No commits yet</p>
                </div>
              </div>
            ) : (
              <div className="min-w-[760px] py-2 text-xs">
                <div
                  className="sticky top-0 z-10 grid h-7 items-center border-y bg-muted/95 px-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur"
                  style={{ gridTemplateColumns: historyColumns }}
                >
                  <span>Graph / refs</span>
                  <span>Commit message</span>
                  <span>Author</span>
                  <span className="text-right">When</span>
                </div>
                {graph.rows.map((row, index) => {
                  const day = row.commit.authoredAt.slice(0, 10);
                  const previousDay = graph.rows[
                    index - 1
                  ]?.commit.authoredAt.slice(0, 10);
                  return (
                    <div
                      key={row.commit.hash}
                      data-high-contrast-row
                      data-current={row.commit.isHead}
                      className={cn(
                        "grid h-8 items-center border-b border-border/50 px-4 hover:bg-muted/50",
                        row.commit.isHead &&
                          "bg-cyan-500/[0.07] shadow-[inset_2px_0_0_0_rgb(6_182_212)]",
                      )}
                      style={{ gridTemplateColumns: historyColumns }}
                      title={`${row.commit.subject}\n${row.commit.hash}\n${fullDateFormatter.format(new Date(row.commit.authoredAt))}`}
                    >
                      <div className="relative h-8 min-w-0 overflow-visible">
                        <div className="absolute inset-y-0 left-0 z-[1] flex items-center">
                          <CommitGraph row={row} width={graphWidth} />
                        </div>
                        {row.commit.refs.length ? (
                          <div
                            className="absolute inset-y-0 z-[2] flex min-w-0 items-center gap-0.5 overflow-hidden pr-1"
                            style={{
                              left: Math.max(28, graphWidth - 4),
                              width: Math.max(
                                48,
                                graphAreaWidth - graphWidth + 4,
                              ),
                            }}
                          >
                            {row.commit.refs.map((gitRef) => (
                              <RefLabel
                                key={`${gitRef.kind}:${gitRef.name}`}
                                gitRef={gitRef}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 pr-4">
                        <span className="truncate font-medium">
                          {row.commit.subject}
                        </span>
                        <code className="shrink-0 text-[10px] text-muted-foreground/70">
                          {row.commit.shortHash}
                        </code>
                      </div>
                      <span className="truncate text-muted-foreground">
                        {row.commit.authorName}
                      </span>
                      <span className="text-right text-[10px] text-muted-foreground">
                        {day !== previousDay
                          ? relativeDate(row.commit.authoredAt)
                          : ""}
                      </span>
                    </div>
                  );
                })}
                <div
                  ref={loadMoreRef}
                  className="grid h-12 place-items-center text-xs text-muted-foreground"
                >
                  {history.isFetchingNextPage ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : history.hasNextPage ? (
                    "Scroll to load more"
                  ) : (
                    `All ${commits.length} commits loaded`
                  )}
                </div>
              </div>
            )}
          </div>
          {changesOpen ? (
            status.data ? (
              <GitChangesPanel
                projectId={project.id}
                status={status.data}
                onClose={() => setChangesOpen(false)}
              />
            ) : (
              <aside className="absolute inset-y-0 right-0 z-20 grid w-full max-w-sm place-items-center border-l bg-background text-sm text-muted-foreground shadow-2xl md:relative md:z-auto md:w-96 md:shadow-none">
                {status.isError ? (
                  <p className="p-6 text-center">
                    {status.error instanceof Error
                      ? status.error.message
                      : "Git status could not be loaded."}
                  </p>
                ) : (
                  <Loader2 className="size-5 animate-spin" />
                )}
              </aside>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
