import type {
  ProjectRepositoryStats,
  ProjectSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import {
  ArrowUpRight,
  Files,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Play,
  Plus,
  Rows3,
} from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProjectSurfaceCreateMenu } from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

const countFormat = new Intl.NumberFormat();

export interface ProjectSurfaceRuntimeState {
  label: string;
  running: boolean;
  tone: "default" | "destructive" | "muted" | "warning";
}

export function projectSurfaceRuntimeState(
  surface: ProjectSurface,
): ProjectSurfaceRuntimeState {
  if (surface.kind === "chat") {
    if (surface.entity.status === "running")
      return { label: "Running", running: true, tone: "default" };
    if (surface.entity.status === "waiting-for-approval")
      return { label: "Needs approval", running: false, tone: "warning" };
    if (surface.entity.status === "failed")
      return { label: "Failed", running: false, tone: "destructive" };
    if (surface.entity.status === "offline")
      return { label: "Offline", running: false, tone: "muted" };
    return { label: "Ready", running: false, tone: "muted" };
  }
  if (surface.kind === "terminal") {
    if (surface.entity.status === "running")
      return { label: "Running", running: true, tone: "default" };
    if (surface.entity.status === "failed")
      return { label: "Failed", running: false, tone: "destructive" };
    if (surface.entity.status === "offline")
      return { label: "Offline", running: false, tone: "muted" };
    if (surface.entity.status === "exited")
      return { label: "Exited", running: false, tone: "muted" };
    return { label: "Ready", running: false, tone: "muted" };
  }
  if (surface.kind === "code") {
    if (["running", "starting"].includes(surface.entity.status)) {
      return {
        label: surface.entity.status === "starting" ? "Starting" : "Running",
        running: true,
        tone: "default",
      };
    }
    if (surface.entity.status === "failed")
      return { label: "Failed", running: false, tone: "destructive" };
    if (surface.entity.status === "offline")
      return { label: "Offline", running: false, tone: "muted" };
    if (surface.entity.status === "stopped")
      return { label: "Stopped", running: false, tone: "muted" };
    return { label: "Ready", running: false, tone: "muted" };
  }
  return { label: "Open", running: false, tone: "muted" };
}

function surfaceKindLabel(kind: ProjectSurface["kind"]): string {
  if (kind === "remote-desktop") return "Remote desktop";
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}

function surfaceWorktreeId(surface: ProjectSurface): string | null {
  if (surface.kind === "chat") return surface.entity.activeWorktreeId;
  if (
    surface.kind === "terminal" ||
    surface.kind === "explorer" ||
    surface.kind === "code"
  ) {
    return surface.entity.worktreeId;
  }
  if (
    surface.kind === "history" ||
    surface.kind === "issues" ||
    surface.kind === "remote-desktop"
  ) {
    return surface.entity.worktreeId;
  }
  return null;
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="rounded-xl border bg-card/70 p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function ProjectOverview({
  creatingKinds,
  onCreateSurface,
  onOpenSurface,
  project,
  stats,
  statsError,
  statsLoading,
  surfaces,
  workerOnline,
  worktrees,
}: {
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreateSurface(kind: ProjectSurfaceCreateKind): void;
  onOpenSurface(tabKey: string): void;
  project: ProjectSummary;
  stats?: ProjectRepositoryStats;
  statsError?: string | null;
  statsLoading: boolean;
  surfaces: readonly ProjectSurface[];
  workerOnline: boolean;
  worktrees: readonly ProjectWorktreeSummary[];
}) {
  const orderedSurfaces = useMemo(
    () =>
      [...surfaces].sort((left, right) =>
        right.entity.updatedAt.localeCompare(left.entity.updatedAt),
      ),
    [surfaces],
  );
  const worktreesById = useMemo(
    () => new Map(worktrees.map((worktree) => [worktree.id, worktree])),
    [worktrees],
  );
  const primaryWorktree =
    worktrees.find(({ isPrimary }) => isPrimary) ?? worktrees[0];
  const runningCount = orderedSurfaces.filter(
    (surface) => projectSurfaceRuntimeState(surface).running,
  ).length;
  const loadingValue = statsLoading ? (
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  ) : (
    "—"
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6 lg:p-8">
        <section className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-4">
              <div className="grid size-12 shrink-0 place-items-center rounded-xl border bg-background/80 shadow-sm">
                <FolderGit2 className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                    {project.name}
                  </h1>
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        workerOnline ? "bg-emerald-500" : "bg-muted-foreground",
                      )}
                    />
                    {workerOnline ? "Worker online" : "Worker offline"}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {project.github?.nameWithOwner ??
                    project.source?.displayPath ??
                    "Repository overview"}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  {primaryWorktree?.branch ? (
                    <span className="inline-flex items-center gap-1.5">
                      <GitBranch className="size-3.5" />
                      {primaryWorktree.branch}
                    </span>
                  ) : null}
                  {primaryWorktree?.head ? (
                    <span className="font-mono">
                      @{primaryWorktree.head.slice(0, 8)}
                    </span>
                  ) : null}
                  <span>
                    {worktrees.length} worktree
                    {worktrees.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {project.github ? (
                <Button asChild variant="outline" size="sm">
                  <a href={project.github.url} target="_blank" rel="noreferrer">
                    Repository
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </Button>
              ) : null}
              <ProjectSurfaceCreateMenu
                creatingKinds={creatingKinds}
                onCreate={onCreateSurface}
                trigger={
                  <Button size="sm" disabled={!project.source}>
                    <Plus className="size-3.5" />
                    New
                  </Button>
                }
              />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            icon={<Rows3 className="size-3.5" />}
            label="Open tabs"
            value={countFormat.format(orderedSurfaces.length)}
            detail="Across this project"
          />
          <MetricCard
            icon={<Play className="size-3.5" />}
            label="Running now"
            value={countFormat.format(runningCount)}
            detail="Chats, terminals, and Code"
          />
          <MetricCard
            icon={<GitCommitHorizontal className="size-3.5" />}
            label="Commits"
            value={stats ? countFormat.format(stats.commitCount) : loadingValue}
            detail="Reachable repository history"
          />
          <MetricCard
            icon={<Files className="size-3.5" />}
            label="Lines of code"
            value={stats ? countFormat.format(stats.lineCount) : loadingValue}
            detail="Lines in tracked text files"
          />
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="font-semibold">Active services</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Open a running surface or resume where you left off.
                </p>
              </div>
              <Badge variant="secondary">{orderedSurfaces.length} open</Badge>
            </div>
            {orderedSurfaces.length > 0 ? (
              <div className="divide-y">
                {orderedSurfaces.map((surface) => {
                  const state = projectSurfaceRuntimeState(surface);
                  const worktreeId = surfaceWorktreeId(surface);
                  const worktree = worktreeId
                    ? worktreesById.get(worktreeId)
                    : undefined;
                  return (
                    <button
                      key={surface.tabKey}
                      type="button"
                      className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                      onClick={() => onOpenSurface(surface.tabKey)}
                    >
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                        <ProjectSurfaceIcon
                          kind={surface.kind}
                          className="size-4"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {surface.title}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {surfaceKindLabel(surface.kind)}
                          {worktree ? ` · ${worktree.name}` : ""}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-1 text-[10px] font-medium",
                          state.tone === "default" &&
                            "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                          state.tone === "warning" &&
                            "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                          state.tone === "destructive" &&
                            "bg-destructive/10 text-destructive",
                          state.tone === "muted" &&
                            "bg-muted text-muted-foreground",
                        )}
                      >
                        {state.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-5 py-10 text-center">
                <Rows3 className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No project tabs yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use New to start a chat, terminal, Code workspace, or browser.
                </p>
              </div>
            )}
          </div>

          <aside className="space-y-5">
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold">Repository</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Tracked files</dt>
                  <dd className="font-medium tabular-nums">
                    {stats ? countFormat.format(stats.trackedFileCount) : "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Text files</dt>
                  <dd className="font-medium tabular-nums">
                    {stats ? countFormat.format(stats.textFileCount) : "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Other files</dt>
                  <dd className="font-medium tabular-nums">
                    {stats ? countFormat.format(stats.excludedFileCount) : "—"}
                  </dd>
                </div>
              </dl>
              {stats?.truncated ? (
                <p className="mt-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  The bounded line scan skipped some large or unavailable files.
                </p>
              ) : statsError ? (
                <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                  {statsError}
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold">Workspace</h2>
              <div className="mt-4 space-y-3">
                {worktrees.slice(0, 4).map((worktree) => (
                  <div key={worktree.id} className="flex items-center gap-3">
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {worktree.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {worktree.branch ?? "Detached"}
                      </div>
                    </div>
                    {worktree.isPrimary ? (
                      <Badge variant="outline" className="text-[10px]">
                        Primary
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
