import type {
  ExecutionTarget,
  ProjectRepositoryStats,
  ProjectSummary,
  ProjectTokenUsage,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";
import {
  ArrowRight,
  ArrowUpRight,
  Coins,
  Files,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  Loader2,
  Play,
  Plus,
  Rows3,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProjectSurfaceCreateMenu } from "@/components/workspace/project-surface-create-menu";
import type {
  ProjectSurfaceCreateKind,
  ProjectSurfacePlacementContext,
} from "@/components/workspace/project-surface-create-menu";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

import { ProjectTokenUsageDialog } from "./project-token-usage-dialog";
import { formatTokenCount } from "./token-usage-analytics";

const countFormat = new Intl.NumberFormat();
const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatByteCount(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    byteUnits.length - 1,
  );
  if (unitIndex === 0) return `${Math.round(bytes)} B`;
  const value = bytes / 1024 ** unitIndex;
  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(fractionDigits))} ${byteUnits[unitIndex]}`;
}

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
  if (kind === "chat") return "Agent";
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="rounded-xl border bg-card/70 p-4 text-left shadow-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="rounded-xl border bg-card/70 p-4 shadow-sm">{content}</div>
  );
}

export function ProjectOverview({
  compact = false,
  creatingKinds,
  onCreateSurface,
  onOpenSurface,
  onOpenTabs,
  placement,
  project,
  stats,
  statsError,
  statsLoading,
  surfaces,
  usage,
  usageError,
  usageLoading,
  workerOnline,
  worktrees,
}: {
  compact?: boolean;
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreateSurface(
    kind: ProjectSurfaceCreateKind,
    target?: ExecutionTarget,
  ): void;
  onOpenSurface(tabKey: string): void;
  onOpenTabs?: () => void;
  placement?: ProjectSurfacePlacementContext;
  project: ProjectSummary;
  stats?: ProjectRepositoryStats;
  statsError?: string | null;
  statsLoading: boolean;
  surfaces: readonly ProjectSurface[];
  usage?: ProjectTokenUsage;
  usageError?: string | null;
  usageLoading: boolean;
  workerOnline: boolean;
  worktrees: readonly ProjectWorktreeSummary[];
}) {
  const [usageOpen, setUsageOpen] = useState(false);
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
  const folderStats = stats?.kind === "folder" ? stats : null;
  const gitStats = stats?.kind === "git" ? stats : null;
  const folderProject = project.originKind === "managed-folder";
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
                {folderProject ? (
                  <Folder className="size-5" />
                ) : (
                  <FolderGit2 className="size-5" />
                )}
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
                    "Project overview"}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  {folderProject ? (
                    <Badge variant="secondary">Folder</Badge>
                  ) : primaryWorktree?.branch ? (
                    <span className="inline-flex items-center gap-1.5">
                      <GitBranch className="size-3.5" />
                      {primaryWorktree.branch}
                    </span>
                  ) : null}
                  {!folderProject && primaryWorktree?.head ? (
                    <span className="font-mono">
                      @{primaryWorktree.head.slice(0, 8)}
                    </span>
                  ) : null}
                  {!folderProject ? (
                    <span>
                      {worktrees.length} worktree
                      {worktrees.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
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
                placement={placement}
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

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
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
            detail="Agents, terminals, and Code"
          />
          <MetricCard
            icon={
              folderProject ? (
                <Folder className="size-3.5" />
              ) : (
                <GitCommitHorizontal className="size-3.5" />
              )
            }
            label={folderProject ? "Files" : "Commits"}
            value={
              folderStats
                ? countFormat.format(folderStats.fileCount)
                : gitStats
                  ? countFormat.format(gitStats.commitCount)
                  : loadingValue
            }
            detail={
              folderProject
                ? "Files in this folder"
                : "Reachable repository history"
            }
          />
          <MetricCard
            icon={<Files className="size-3.5" />}
            label={folderProject ? "Lines of text" : "Lines of code"}
            value={stats ? countFormat.format(stats.lineCount) : loadingValue}
            detail={
              folderProject
                ? "Lines in bounded text files"
                : "Lines in tracked text files"
            }
          />
          <MetricCard
            icon={<HardDrive className="size-3.5" />}
            label={folderProject ? "Folder size" : "Repository size"}
            value={
              folderStats
                ? formatByteCount(folderStats.byteCount)
                : gitStats
                  ? formatByteCount(gitStats.trackedByteCount)
                  : loadingValue
            }
            detail={
              folderProject
                ? "Files scanned on this worker"
                : "Tracked files on this worker"
            }
          />
          <MetricCard
            icon={<Coins className="size-3.5" />}
            label="Token usage"
            value={
              usage
                ? formatTokenCount(usage.total.totalTokens)
                : usageLoading
                  ? loadingValue
                  : "—"
            }
            detail={usageError ?? "Input and output tokens"}
            onClick={usage ? () => setUsageOpen(true) : undefined}
          />
        </section>

        <section
          className={cn(
            "grid gap-5",
            !compact && "lg:grid-cols-[minmax(0,1fr)_18rem]",
          )}
        >
          {compact ? (
            <button
              className="group flex items-center gap-4 rounded-2xl border bg-card p-5 text-left shadow-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenTabs}
              type="button"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
                <Rows3 className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Open tabs</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {orderedSurfaces.length} open · {runningCount} running
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          ) : (
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
                <div className="overflow-x-auto">
                  <table className="w-full table-fixed text-left">
                    <thead className="border-b bg-muted/20 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Service</th>
                        <th className="hidden w-28 px-3 py-2 font-medium sm:table-cell">
                          Type
                        </th>
                        <th className="hidden w-28 px-3 py-2 font-medium md:table-cell">
                          {folderProject ? "Folder" : "Worktree"}
                        </th>
                        <th className="w-24 px-3 py-2 text-right font-medium">
                          Status
                        </th>
                        <th className="w-8" aria-label="Open tab" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {orderedSurfaces.map((surface) => {
                        const state = projectSurfaceRuntimeState(surface);
                        const worktreeId = surfaceWorktreeId(surface);
                        const worktree = worktreeId
                          ? worktreesById.get(worktreeId)
                          : undefined;
                        const openSurface = () => onOpenSurface(surface.tabKey);
                        return (
                          <tr
                            key={surface.tabKey}
                            aria-label={`Open ${surface.title}`}
                            className="group cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                            tabIndex={0}
                            onClick={openSurface}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ")
                                return;
                              event.preventDefault();
                              openSurface();
                            }}
                          >
                            <td className="px-4 py-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <ProjectSurfaceIcon
                                  kind={
                                    surface.kind === "chat" &&
                                    surface.entity.experience === "task"
                                      ? "task"
                                      : surface.kind
                                  }
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                />
                                <span className="truncate text-xs font-medium">
                                  {surface.title}
                                </span>
                                <span className="truncate text-[10px] text-muted-foreground sm:hidden">
                                  {surfaceKindLabel(surface.kind)}
                                </span>
                              </div>
                            </td>
                            <td className="hidden truncate px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                              {surfaceKindLabel(surface.kind)}
                            </td>
                            <td className="hidden truncate px-3 py-2 text-xs text-muted-foreground md:table-cell">
                              {folderProject
                                ? (project.source?.displayPath ?? "—")
                                : (worktree?.name ?? "—")}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span
                                className={cn(
                                  "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
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
                            </td>
                            <td className="pr-3 text-right">
                              <ArrowRight className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-5 py-10 text-center">
                  <Rows3 className="mx-auto size-5 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">
                    No project tabs yet
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use New to start an agent, terminal, Code workspace, or
                    browser.
                  </p>
                </div>
              )}
            </div>
          )}

          <aside className="space-y-5">
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold">
                {folderProject ? "Folder" : "Repository"}
              </h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {folderProject ? "Files" : "Tracked files"}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {folderStats
                      ? countFormat.format(folderStats.fileCount)
                      : gitStats
                        ? countFormat.format(gitStats.trackedFileCount)
                        : "—"}
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
              {statsError ? (
                <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                  {statsError}
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="font-semibold">
                {folderProject ? "Location" : "Workspace"}
              </h2>
              {folderProject ? (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Folder className="size-4 text-muted-foreground" />
                    Worker-bound folder
                  </div>
                  <code className="block break-all text-xs text-muted-foreground">
                    {project.source?.displayPath ?? "Source unavailable"}
                  </code>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Available through Cantrip while the owning worker is online.
                  </p>
                </div>
              ) : (
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
              )}
            </div>
          </aside>
        </section>
      </main>
      {usage ? (
        <ProjectTokenUsageDialog
          open={usageOpen}
          onOpenChange={setUsageOpen}
          projectName={project.name}
          usage={usage}
        />
      ) : null}
    </div>
  );
}
