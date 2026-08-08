import type {
  ChatSummary,
  GitCommit,
  GitRef,
  GitStatus,
  GithubIssueList,
  GithubIssueState,
  ProjectSummary,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  ScanLine,
  Tag,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createProjectWorktree,
  getGithubIssues,
  getProjectWorktreeHistory,
  lockProjectWorktree,
  pruneProjectWorktrees,
  reconcileProjectWorktrees,
  removeProjectWorktree,
  runProjectWorktreeGitAction,
  unlockProjectWorktree,
} from "@/lib/api";
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
  WorktreeControl,
  WorktreeCreateDialog,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";
import { cn } from "@/lib/utils";

import { GitChangesPanel } from "./git-changes-panel";
import { HistoryWorktreeMarker } from "./history-worktree-marker";
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

export interface GraphRow {
  commit: GitCommit;
  edges: Array<{ color: string; from: number; to: number }>;
  introduced: boolean;
  lane: number;
  nodeColor: string;
  passthrough: Array<{ color: string; from: number; to: number }>;
}

export function graphRows(commits: GitCommit[]): {
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

export type HistoryDisplayRow =
  | { kind: "commit"; graph: GraphRow; worktrees: ProjectWorktreeSummary[] }
  | {
      kind: "wip";
      graph: GraphRow;
      status: GitStatus;
      worktree: ProjectWorktreeSummary;
    };

export function buildHistoryDisplayRows(
  rows: GraphRow[],
  worktrees: ProjectWorktreeSummary[],
  statuses: WorktreeStatusMap,
): HistoryDisplayRow[] {
  const worktreesByHead = new Map<string, ProjectWorktreeSummary[]>();
  for (const worktree of worktrees) {
    if (!worktree.head) continue;
    const markers = worktreesByHead.get(worktree.head) ?? [];
    markers.push(worktree);
    worktreesByHead.set(worktree.head, markers);
  }
  return rows.flatMap((graph) => {
    const markers = worktreesByHead.get(graph.commit.hash) ?? [];
    const wip = markers.flatMap((worktree): HistoryDisplayRow[] => {
      const status = statuses[worktree.id];
      return status?.files.length
        ? [{ kind: "wip", graph, status, worktree }]
        : [];
    });
    return [
      ...wip,
      { kind: "commit", graph, worktrees: markers } as HistoryDisplayRow,
    ];
  });
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
        "inline-flex h-4 max-w-24 shrink-0 items-center gap-0.5 rounded px-1 text-[9px] font-medium",
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

function CommitGraph({
  connectFromTop = false,
  row,
  width,
}: {
  connectFromTop?: boolean;
  row: GraphRow;
  width: number;
}) {
  const x = (lane: number) => 10 + lane * 16;
  return (
    <svg
      width={width}
      height="32"
      className="block overflow-visible"
      aria-hidden="true"
    >
      {!row.introduced || connectFromTop ? (
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

function WorktreeWipGraph({
  color,
  connectFromTop,
  lane,
  width,
}: {
  color: string;
  connectFromTop: boolean;
  lane: number;
  width: number;
}) {
  const x = 10 + lane * 16;
  return (
    <svg
      width={width}
      height="32"
      className="block overflow-visible"
      aria-hidden="true"
    >
      {connectFromTop ? (
        <path
          d={`M ${x} -1 L ${x} 16`}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeDasharray="2 3"
        />
      ) : null}
      <path
        d={`M ${x} 16 L ${x} 33`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray="2 3"
      />
      <circle
        cx={x}
        cy="16"
        r="5"
        fill="var(--background)"
        stroke={color}
        strokeWidth="2"
        strokeDasharray="2 2"
      />
    </svg>
  );
}

export interface GitHistoryHeaderState {
  branch: string;
  canPush: boolean;
  commitsLoaded: number;
  head: string | null;
  isFetching: boolean;
  issueCount: number | null;
  issueState: GithubIssueState;
  isGitActionPending: boolean;
  pull(): void;
  push(): void;
  refresh(): void;
}

export function GitHistoryView({
  chats,
  onCreateChat,
  onCreateExplorer,
  onCreateHistory,
  onCreateTerminal,
  onHeaderChange,
  onOpenChat,
  onSelectWorktree,
  project,
  standalone = false,
  statuses,
  view,
  workers,
  worktreeId,
  worktrees,
}: {
  chats: ChatSummary[];
  onCreateChat(worktreeId: string): void;
  onCreateExplorer(worktreeId: string): void;
  onCreateHistory(worktreeId: string): void;
  onCreateTerminal(worktreeId: string): void;
  onHeaderChange(state: GitHistoryHeaderState | null): void;
  onOpenChat(chatId: string): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSummary;
  standalone?: boolean;
  statuses: WorktreeStatusMap;
  view: "history" | "issues";
  workers: WorkerSummary[];
  worktreeId: string;
  worktrees: ProjectWorktreeSummary[];
}) {
  const queryClient = useQueryClient();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [issueState, setIssueState] = useState<GithubIssueState>("open");
  const [issueRefreshEpoch, setIssueRefreshEpoch] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [allowExternalPrune, setAllowExternalPrune] = useState(false);
  const [removeTarget, setRemoveTarget] =
    useState<ProjectWorktreeSummary | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const selectedWorktree = worktrees.find(({ id }) => id === worktreeId);
  const selectedWorker = workers.find(
    ({ workerId }) => workerId === selectedWorktree?.workerId,
  );
  const selectedAvailable = Boolean(
    selectedWorktree?.lifecycleState === "ready" && selectedWorker?.online,
  );
  const status = statuses[worktreeId];
  const history = useInfiniteQuery({
    enabled: view === "history" && selectedAvailable,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getProjectWorktreeHistory(project.id, worktreeId, pageParam),
    queryKey: ["worktree-history", project.id, worktreeId],
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const issues = useInfiniteQuery({
    enabled: view === "issues" && Boolean(project.github),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      getGithubIssues(project.id, issueState, pageParam),
    queryKey: ["github-issues", project.id, issueState, issueRefreshEpoch],
    getNextPageParam: (page) => page.nextPage ?? undefined,
  });
  const refreshIssues = useCallback(
    () => setIssueRefreshEpoch((epoch) => epoch + 1),
    [],
  );
  const gitAction = useMutation({
    mutationFn: (type: "pull" | "push") =>
      runProjectWorktreeGitAction(project.id, worktreeId, { type }),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["worktree-status", project.id, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", project.id, worktreeId],
      });
    },
  });
  const reconcile = useMutation({
    mutationFn: () => reconcileProjectWorktrees(project.id),
    onSuccess: (next) => {
      queryClient.setQueryData(["worktrees", project.id], next);
      void queryClient.invalidateQueries({
        queryKey: ["worktree-status", project.id],
      });
      void history.refetch();
    },
  });
  const createWorktree = useMutation({
    mutationFn: (input: ProjectWorktreeCreate) =>
      createProjectWorktree(project.id, input),
    onSuccess: (created) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) => [
          ...current.filter(({ id }) => id !== created.id),
          created,
        ],
      );
      onSelectWorktree(created.id);
    },
  });
  const lockWorktree = useMutation({
    mutationFn: (worktree: ProjectWorktreeSummary) =>
      worktree.locked
        ? unlockProjectWorktree(project.id, worktree.id)
        : lockProjectWorktree(project.id, worktree.id, "Locked from History"),
    onSuccess: (updated) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) =>
          current.map((worktree) =>
            worktree.id === updated.id ? updated : worktree,
          ),
      );
    },
  });
  const pruneWorktrees = useMutation({
    mutationFn: () => pruneProjectWorktrees(project.id, allowExternalPrune),
    onSuccess: (next) => {
      queryClient.setQueryData(["worktrees", project.id], next);
      setPruneOpen(false);
      setAllowExternalPrune(false);
    },
  });
  const removeWorktree = useMutation({
    mutationFn: (target: ProjectWorktreeSummary) =>
      removeProjectWorktree(project.id, target.id, {
        allowExternal: target.origin === "external",
        force: forceRemove,
      }),
    onSuccess: (updated, target) => {
      queryClient.setQueryData<ProjectWorktreeSummary[]>(
        ["worktrees", project.id],
        (current = []) =>
          current.map((worktree) =>
            worktree.id === updated.id ? updated : worktree,
          ),
      );
      if (target.id === worktreeId) {
        const primary = worktrees.find(({ isPrimary }) => isPrimary);
        if (primary) onSelectWorktree(primary.id);
      }
      setRemoveTarget(null);
      setForceRemove(false);
    },
  });
  const commits = useMemo(
    () => history.data?.pages.flatMap((page) => page.commits) ?? [],
    [history.data],
  );
  const graph = useMemo(() => graphRows(commits), [commits]);
  const displayRows = useMemo(
    () => buildHistoryDisplayRows(graph.rows, worktrees, statuses),
    [graph.rows, statuses, worktrees],
  );
  const previousCommitDay = useMemo(
    () =>
      new Map(
        graph.rows.map((row, index) => [
          row.commit.hash,
          graph.rows[index - 1]?.commit.authoredAt.slice(0, 10) ?? null,
        ]),
      ),
    [graph.rows],
  );
  const graphWidth = Math.max(42, graph.maxLanes * 16 + 12);
  const graphAreaWidth = Math.min(260, Math.max(160, graphWidth + 126));
  const historyColumns = `${graphAreaWidth}px minmax(320px, 1fr) 150px 82px`;
  const firstPage = history.data?.pages[0];
  const loadedIssues = useMemo<GithubIssueList | undefined>(() => {
    if (!issues.data) return undefined;
    const values = issues.data.pages.flatMap((page) => page.issues);
    return {
      state: issueState,
      total: values.length,
      issues: values,
      nextPage: issues.data.pages.at(-1)?.nextPage ?? null,
    };
  }, [issueState, issues.data]);
  const issuesRefreshing =
    issues.isFetching && !issues.isFetchingNextPage && !issues.isLoading;

  useEffect(() => {
    onHeaderChange({
      branch:
        firstPage?.branch ?? status?.branch ?? selectedWorktree?.branch ?? "",
      canPush: Boolean(
        status?.head &&
        status.branch &&
        (status.ahead > 0 ||
          (!status.upstream &&
            status.branches.some((branch) => branch.kind === "remote"))),
      ),
      commitsLoaded: commits.length,
      head: firstPage?.head ?? selectedWorktree?.head ?? null,
      isFetching:
        view === "history"
          ? history.isFetching || reconcile.isPending
          : issuesRefreshing,
      issueCount: loadedIssues?.total ?? null,
      issueState,
      isGitActionPending: gitAction.isPending,
      pull: () => gitAction.mutate("pull"),
      push: () => gitAction.mutate("push"),
      refresh: () => {
        if (view === "history") {
          reconcile.mutate();
          void queryClient.invalidateQueries({
            queryKey: ["worktree-status", project.id],
          });
        } else {
          refreshIssues();
        }
      },
    });
  }, [
    commits.length,
    firstPage,
    history.isFetching,
    history.refetch,
    gitAction.isPending,
    gitAction.mutate,
    issueState,
    issuesRefreshing,
    loadedIssues?.total,
    onHeaderChange,
    project.id,
    queryClient,
    refreshIssues,
    reconcile.isPending,
    reconcile.mutate,
    selectedWorktree?.branch,
    selectedWorktree?.head,
    status?.ahead,
    status?.branch,
    status?.branches,
    status?.head,
    status?.upstream,
    view,
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
      {standalone ? (
        <div className="flex h-11 shrink-0 items-center justify-end gap-1 border-b px-3">
          {view === "history" ? (
            <>
              {selectedWorktree ? (
                <WorktreeControl
                  currentWorktreeId={worktreeId}
                  worktrees={worktrees}
                  statuses={statuses}
                  workers={workers}
                  actions={{
                    disabled: gitAction.isPending,
                    pending: gitAction.isPending,
                    onCreate: () => setCreateOpen(true),
                    onSelect: onSelectWorktree,
                  }}
                />
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={gitAction.isPending || !selectedAvailable}
                onClick={() => gitAction.mutate("pull")}
              >
                <ArrowDownToLine className="size-4" /> Pull
              </Button>
              {Boolean(
                status?.head &&
                status.branch &&
                (status.ahead > 0 ||
                  (!status.upstream &&
                    status.branches.some(
                      (branch) => branch.kind === "remote",
                    ))),
              ) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={gitAction.isPending}
                  onClick={() => gitAction.mutate("push")}
                >
                  <ArrowUpFromLine className="size-4" /> Push
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={history.isFetching || reconcile.isPending}
            onClick={() =>
              view === "history" ? reconcile.mutate() : refreshIssues()
            }
            title="Refresh"
          >
            <RefreshCw
              className={cn(
                "size-4",
                (view === "history"
                  ? history.isFetching || reconcile.isPending
                  : issuesRefreshing) && "animate-spin",
              )}
            />
            <span className="sr-only">Refresh</span>
          </Button>
        </div>
      ) : null}
      {gitAction.error ? (
        <p className="shrink-0 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {gitAction.error instanceof Error
            ? gitAction.error.message
            : "Git sync failed."}
        </p>
      ) : null}
      {reconcile.error || lockWorktree.error ? (
        <p className="shrink-0 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {(reconcile.error ?? lockWorktree.error) instanceof Error
            ? (reconcile.error ?? lockWorktree.error)?.message
            : "Worktree operation failed."}
        </p>
      ) : null}

      {view === "issues" ? (
        <GithubIssuesView
          error={issues.error}
          hasNextPage={issues.hasNextPage}
          isFetching={issuesRefreshing}
          isFetchingNextPage={issues.isFetchingNextPage}
          isLoading={issues.isLoading}
          issues={loadedIssues}
          project={project}
          state={issueState}
          onLoadMore={() => void issues.fetchNextPage()}
          onRefresh={refreshIssues}
          onStateChange={setIssueState}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {!selectedWorktree ? (
              <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
                This History tab no longer has a worktree selection.
              </div>
            ) : !selectedAvailable && commits.length === 0 ? (
              <div className="grid min-h-64 place-items-center text-center text-sm text-muted-foreground">
                <div>
                  <GitFork className="mx-auto mb-3 size-6" />
                  <p className="font-medium text-foreground">
                    {selectedWorktree.name} is unavailable
                  </p>
                  <p className="mt-1">
                    {selectedWorktree.lifecycleState !== "ready"
                      ? `Worktree state: ${selectedWorktree.lifecycleState}`
                      : "Its worker is offline."}
                  </p>
                </div>
              </div>
            ) : history.isLoading ? (
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
                  <div className="flex items-center gap-1">
                    <span>Graph / worktrees</span>
                    <button
                      type="button"
                      className="ml-auto rounded p-1 hover:bg-background/70 hover:text-foreground"
                      onClick={() => setCreateOpen(true)}
                      title="Create worktree"
                    >
                      <Plus className="size-3" />
                      <span className="sr-only">Create worktree</span>
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-background/70 hover:text-foreground"
                      onClick={() => setPruneOpen(true)}
                      title="Prune stale worktree metadata"
                    >
                      <ScanLine className="size-3" />
                      <span className="sr-only">Prune worktrees</span>
                    </button>
                  </div>
                  <span>Commit message</span>
                  <span>Author</span>
                  <span className="text-right">When</span>
                </div>
                {displayRows.map((displayRow, index) => {
                  if (displayRow.kind === "wip") {
                    const {
                      graph: row,
                      status: rowStatus,
                      worktree,
                    } = displayRow;
                    const boundChats = chats.filter(
                      ({ activeWorktreeId }) =>
                        activeWorktreeId === worktree.id,
                    );
                    const staged = rowStatus.files.filter(
                      ({ staged }) => staged,
                    ).length;
                    const unstaged = rowStatus.files.filter(
                      ({ unstaged }) => unstaged,
                    ).length;
                    const selected = worktree.id === worktreeId;
                    return (
                      <button
                        key={`wip:${worktree.id}:${row.commit.hash}`}
                        type="button"
                        data-high-contrast-row
                        className={cn(
                          "grid h-8 w-full items-center bg-muted/35 px-4 text-left hover:bg-muted/65",
                          selected &&
                            "bg-amber-500/[0.08] shadow-[inset_2px_0_0_0_rgb(245_158_11)]",
                        )}
                        style={{ gridTemplateColumns: historyColumns }}
                        onClick={() => {
                          onSelectWorktree(worktree.id);
                          setChangesOpen(true);
                        }}
                        title={`Open ${worktree.name} staged and unstaged changes`}
                      >
                        <div className="relative h-8 min-w-0 overflow-visible">
                          <div className="absolute inset-y-0 left-0 z-[1] flex items-center">
                            <WorktreeWipGraph
                              color={row.nodeColor}
                              connectFromTop={
                                displayRows[index - 1]?.kind === "wip" &&
                                displayRows[index - 1]?.graph.commit.hash ===
                                  row.commit.hash
                              }
                              lane={row.lane}
                              width={graphWidth}
                            />
                          </div>
                          <div
                            className="absolute inset-y-0 z-[2] flex min-w-0 items-center overflow-hidden pr-1"
                            style={{
                              left: Math.max(28, graphWidth - 4),
                              width: Math.max(
                                58,
                                graphAreaWidth - graphWidth + 4,
                              ),
                            }}
                          >
                            <span className="inline-flex h-4 min-w-0 items-center gap-1 rounded bg-muted px-1.5 text-[9px] font-medium text-muted-foreground">
                              // WIP · {worktree.name}
                            </span>
                          </div>
                        </div>
                        <div className="flex min-w-0 items-center gap-2 pr-4">
                          <FileDiff className="size-3.5 shrink-0 text-amber-500" />
                          <span className="truncate font-medium">
                            {rowStatus.files.length} working{" "}
                            {rowStatus.files.length === 1
                              ? "change"
                              : "changes"}
                          </span>
                          {unstaged ? (
                            <span className="shrink-0 text-amber-600 dark:text-amber-400">
                              {unstaged} unstaged
                            </span>
                          ) : null}
                          {staged ? (
                            <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
                              {staged} staged
                            </span>
                          ) : null}
                        </div>
                        <span className="truncate text-muted-foreground">
                          {boundChats.length
                            ? boundChats.map(({ title }) => title).join(", ")
                            : worktree.origin}
                        </span>
                        <span className="text-right text-[10px] text-muted-foreground">
                          now
                        </span>
                      </button>
                    );
                  }
                  const row = displayRow.graph;
                  const day = row.commit.authoredAt.slice(0, 10);
                  const selectedHead = displayRow.worktrees.some(
                    ({ id }) => id === worktreeId,
                  );
                  const connectsFromWip =
                    displayRows[index - 1]?.kind === "wip" &&
                    displayRows[index - 1]?.graph.commit.hash ===
                      row.commit.hash;
                  return (
                    <div
                      key={row.commit.hash}
                      data-high-contrast-row
                      data-current={row.commit.isHead}
                      className={cn(
                        "grid h-8 items-center border-b border-border/50 px-4 hover:bg-muted/50",
                        selectedHead &&
                          "bg-cyan-500/[0.07] shadow-[inset_2px_0_0_0_rgb(6_182_212)]",
                      )}
                      style={{ gridTemplateColumns: historyColumns }}
                      title={`${row.commit.subject}\n${row.commit.hash}\n${fullDateFormatter.format(new Date(row.commit.authoredAt))}`}
                    >
                      <div className="relative h-8 min-w-0 overflow-visible">
                        <div className="absolute inset-y-0 left-0 z-[1] flex items-center">
                          <CommitGraph
                            row={row}
                            width={graphWidth}
                            connectFromTop={connectsFromWip}
                          />
                        </div>
                        {displayRow.worktrees.length ? (
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
                            {[...displayRow.worktrees]
                              .sort(
                                (left, right) =>
                                  Number(right.id === worktreeId) -
                                  Number(left.id === worktreeId),
                              )
                              .map((worktree) => {
                                const boundChats = chats.filter(
                                  ({ activeWorktreeId }) =>
                                    activeWorktreeId === worktree.id,
                                );
                                return (
                                  <HistoryWorktreeMarker
                                    key={worktree.id}
                                    worktree={worktree}
                                    worker={workers.find(
                                      ({ workerId }) =>
                                        workerId === worktree.workerId,
                                    )}
                                    status={statuses[worktree.id]}
                                    boundChats={boundChats}
                                    selected={worktree.id === worktreeId}
                                    onSelect={() =>
                                      onSelectWorktree(worktree.id)
                                    }
                                    onOpenChat={(chatId) =>
                                      chatId
                                        ? onOpenChat(chatId)
                                        : onCreateChat(worktree.id)
                                    }
                                    onOpenTerminal={() =>
                                      onCreateTerminal(worktree.id)
                                    }
                                    onOpenExplorer={() =>
                                      onCreateExplorer(worktree.id)
                                    }
                                    onOpenHistory={() =>
                                      onCreateHistory(worktree.id)
                                    }
                                    onLockToggle={() =>
                                      lockWorktree.mutate(worktree)
                                    }
                                    onRemove={() => {
                                      setForceRemove(false);
                                      setRemoveTarget(worktree);
                                    }}
                                  />
                                );
                              })}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 pr-4">
                        {row.commit.refs.slice(0, 2).map((gitRef) => (
                          <RefLabel
                            key={`${gitRef.kind}:${gitRef.name}`}
                            gitRef={gitRef}
                          />
                        ))}
                        {row.commit.refs.length > 2 ? (
                          <span
                            className="shrink-0 text-[9px] text-muted-foreground"
                            title={row.commit.refs
                              .slice(2)
                              .map(({ name }) => name)
                              .join("\n")}
                          >
                            +{row.commit.refs.length - 2}
                          </span>
                        ) : null}
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
                        {day !== previousCommitDay.get(row.commit.hash)
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
            status ? (
              <GitChangesPanel
                projectId={project.id}
                worktreeId={worktreeId}
                worktreeName={selectedWorktree?.name ?? "Worktree"}
                status={status}
                onClose={() => setChangesOpen(false)}
              />
            ) : (
              <aside className="absolute inset-y-0 right-0 z-20 grid w-full max-w-sm place-items-center border-l bg-background text-sm text-muted-foreground shadow-2xl md:relative md:z-auto md:w-96 md:shadow-none">
                <p className="p-6 text-center">
                  Git status is unavailable for this worktree.
                </p>
              </aside>
            )
          ) : null}
        </div>
      )}

      <WorktreeCreateDialog
        open={createOpen}
        pending={createWorktree.isPending}
        onOpenChange={setCreateOpen}
        onSubmit={(input) =>
          createWorktree.mutateAsync(input).then(() => undefined)
        }
      />

      <Dialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prune stale worktrees?</DialogTitle>
            <DialogDescription>
              This asks Git to prune stale worktree administrative metadata. It
              does not delete branches or healthy checkouts.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={allowExternalPrune}
              onChange={(event) => setAllowExternalPrune(event.target.checked)}
            />
            <span>
              Include stale external worktree metadata. External checkouts are
              never removed silently.
            </span>
          </label>
          {pruneWorktrees.error ? (
            <p className="text-sm text-destructive">
              {pruneWorktrees.error instanceof Error
                ? pruneWorktrees.error.message
                : "Worktree prune failed."}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPruneOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pruneWorktrees.isPending}
              onClick={() => pruneWorktrees.mutate()}
            >
              {pruneWorktrees.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Prune
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setForceRemove(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>
              The worker will remove this physical checkout after verifying it
              is safe. Its Git branch is retained and must be deleted separately
              if you no longer need it.
            </DialogDescription>
          </DialogHeader>
          {removeTarget?.origin === "external" ? (
            <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              This checkout was discovered outside Cantrip. Confirming
              explicitly authorizes removal of the external worktree.
            </p>
          ) : null}
          {removeTarget && statuses[removeTarget.id]?.files.length ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={forceRemove}
                onChange={(event) => setForceRemove(event.target.checked)}
              />
              <span>
                I understand this worktree has uncommitted changes and want to
                force its removal.
              </span>
            </label>
          ) : null}
          {removeWorktree.error ? (
            <p className="text-sm text-destructive">
              {removeWorktree.error instanceof Error
                ? removeWorktree.error.message
                : "Worktree removal failed."}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                removeWorktree.isPending ||
                Boolean(
                  removeTarget &&
                  statuses[removeTarget.id]?.files.length &&
                  !forceRemove,
                )
              }
              onClick={() => {
                if (removeTarget) removeWorktree.mutate(removeTarget);
              }}
            >
              {removeWorktree.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Remove worktree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
