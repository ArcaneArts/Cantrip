import type { GitGraphMetricState, GitGraphSnapshot } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  LocateFixed,
  Network,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  RepositoryGraphSurface,
  type RepositoryGraphInputNode,
} from "@/components/repository-graph";
import { Button } from "@/components/ui/button";
import {
  getProjectWorktreeGraphCommitOverlay,
  getProjectWorktreeGraphMetrics,
  getProjectWorktreeGraphSnapshot,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  applyGitGraphCommitOverlay,
  buildGitGraphDisplayModel,
  gitGraphDimensionNeedsMetrics,
  type GitGraphColorDimension,
  type GitGraphLegend,
  type GitGraphSizeDimension,
} from "./git-graph-model";
import {
  DEFAULT_GIT_GRAPH_STATE,
  hasStoredGitGraphState,
  readGitGraphState,
  writeGitGraphState,
} from "./git-graph-state";

const SIZE_DIMENSIONS: Array<{ label: string; value: GitGraphSizeDimension }> =
  [
    { label: "Equal", value: "equal" },
    { label: "Lines of code", value: "lines" },
    { label: "File bytes", value: "bytes" },
    { label: "Commit touches", value: "commits" },
    { label: "Cumulative churn", value: "churn" },
  ];

const COLOR_DIMENSIONS: Array<{
  label: string;
  value: GitGraphColorDimension;
}> = [
  { label: "Language / type", value: "language" },
  { label: "Commit touches", value: "commits" },
  { label: "Cumulative churn", value: "churn" },
  { label: "Time since last change", value: "last-change" },
  { label: "Age since creation", value: "creation-age" },
  { label: "Blame owner", value: "blame-owner" },
  { label: "Surviving line age", value: "blame-age" },
];

export type GitRepositoryGraphStatus = {
  head: string | null;
  isFetching: boolean;
  nodeCount: number;
};

function dimensionDisabled(
  dimension: GitGraphSizeDimension | GitGraphColorDimension,
  metricsReady: boolean,
): boolean {
  return gitGraphDimensionNeedsMetrics(dimension) && !metricsReady;
}

function metricStatusLabel(state: GitGraphMetricState): string {
  switch (state) {
    case "ready":
      return "ready";
    case "pending":
      return "calculating";
    case "deferred":
      return "on demand";
    case "unavailable":
      return "unavailable";
  }
}

function GraphLegend({
  legend,
  role,
}: {
  legend: GitGraphLegend;
  role: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {role}
      </p>
      <p className="truncate text-xs font-medium">{legend.label}</p>
      <p className="truncate text-[10px] text-muted-foreground">
        {legend.unavailable
          ? "Calculating or unavailable"
          : legend.minimum && legend.maximum
            ? `${legend.minimum} – ${legend.maximum}`
            : "Categorical scale"}
      </p>
    </div>
  );
}

function graphBreadcrumbs(
  snapshot: GitGraphSnapshot,
  focusedNodeId: string | null,
) {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const breadcrumbs: GitGraphSnapshot["nodes"] = [];
  let current = byId.get(focusedNodeId ?? snapshot.rootId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    breadcrumbs.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return breadcrumbs;
}

export function GitRepositoryGraphView({
  commitRevision = null,
  onClearCommit,
  onOpenCommit,
  projectId,
  refreshEpoch,
  rootPath = null,
  worktreeId,
  onActivateFile,
  onBack,
  onRevealNode,
  onStatusChange,
}: {
  commitRevision?: string | null;
  onClearCommit?(): void;
  onOpenCommit?(revision: string): void;
  onActivateFile?(path: string): void;
  onBack?(): void;
  onRevealNode?(node: RepositoryGraphInputNode): void;
  onStatusChange?(status: GitRepositoryGraphStatus): void;
  projectId: string;
  refreshEpoch: number;
  rootPath?: string | null;
  worktreeId: string;
}) {
  const [restoredOnMount] = useState(() =>
    hasStoredGitGraphState(projectId, worktreeId),
  );
  const [state, setState] = useState(() =>
    readGitGraphState(projectId, worktreeId),
  );
  const snapshot = useQuery({
    enabled: Boolean(projectId && worktreeId),
    queryKey: [
      "git-graph-snapshot",
      projectId,
      worktreeId,
      rootPath,
      commitRevision ?? "HEAD",
      refreshEpoch,
    ],
    queryFn: () =>
      getProjectWorktreeGraphSnapshot(projectId, worktreeId, {
        maxNodes: 100_000,
        revision: commitRevision ?? "HEAD",
        rootPath,
      }),
    staleTime: 30_000,
  });
  const commitOverlay = useQuery({
    enabled: Boolean(commitRevision && snapshot.data),
    queryKey: [
      "git-graph-commit-overlay",
      projectId,
      worktreeId,
      commitRevision,
      rootPath,
      refreshEpoch,
    ],
    queryFn: () =>
      getProjectWorktreeGraphCommitOverlay(projectId, worktreeId, {
        revision: commitRevision!,
        rootPath,
      }),
    staleTime: 30_000,
  });
  const metrics = useQuery({
    enabled: Boolean(snapshot.data),
    queryKey: [
      "git-graph-metrics",
      projectId,
      worktreeId,
      snapshot.data?.revision ?? "HEAD",
      rootPath,
      refreshEpoch,
    ],
    queryFn: () =>
      getProjectWorktreeGraphMetrics(projectId, worktreeId, {
        maxNodes: 100_000,
        revision: snapshot.data?.revision ?? "HEAD",
        rootPath,
      }),
    staleTime: 30_000,
  });
  const metricsReady = Boolean(metrics.data);
  const sizeDimension = dimensionDisabled(state.sizeDimension, metricsReady)
    ? metrics.isError
      ? "bytes"
      : state.sizeDimension
    : state.sizeDimension;
  const colorDimension = dimensionDisabled(state.colorDimension, metricsReady)
    ? metrics.isError
      ? "language"
      : state.colorDimension
    : state.colorDimension;
  const display = useMemo(() => {
    if (!snapshot.data) return null;
    const base = buildGitGraphDisplayModel(
      snapshot.data,
      metrics.data ?? null,
      sizeDimension,
      colorDimension,
    );
    return commitOverlay.data
      ? applyGitGraphCommitOverlay(base, snapshot.data, commitOverlay.data)
      : base;
  }, [
    colorDimension,
    commitOverlay.data,
    metrics.data,
    sizeDimension,
    snapshot.data,
  ]);
  const breadcrumbs = useMemo(
    () =>
      snapshot.data ? graphBreadcrumbs(snapshot.data, state.focusedNodeId) : [],
    [snapshot.data, state.focusedNodeId],
  );
  const rootNodeId =
    state.focusedNodeId &&
    snapshot.data?.nodes.some((node) => node.id === state.focusedNodeId)
      ? state.focusedNodeId
      : snapshot.data?.rootId;
  const selectedGraphNode =
    display?.nodes.find((node) => node.id === state.selectedNodeId) ?? null;

  useEffect(() => {
    const timer = window.setTimeout(
      () => writeGitGraphState(projectId, worktreeId, state),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [projectId, state, worktreeId]);

  useEffect(() => {
    if (!snapshot.data) return;
    setState((current) => ({
      ...current,
      focusedNodeId:
        current.focusedNodeId &&
        snapshot.data.nodes.some((node) => node.id === current.focusedNodeId)
          ? current.focusedNodeId
          : null,
      selectedNodeId:
        current.selectedNodeId &&
        snapshot.data.nodes.some((node) => node.id === current.selectedNodeId)
          ? current.selectedNodeId
          : null,
    }));
  }, [snapshot.data]);

  useEffect(() => {
    onStatusChange?.({
      head: snapshot.data?.revision ?? null,
      isFetching:
        snapshot.isFetching || metrics.isFetching || commitOverlay.isFetching,
      nodeCount: snapshot.data?.totalNodes ?? 0,
    });
  }, [
    commitOverlay.isFetching,
    metrics.isFetching,
    onStatusChange,
    snapshot.data,
    snapshot.isFetching,
  ]);

  if (snapshot.isLoading) {
    return (
      <div className="grid min-h-64 flex-1 place-items-center text-muted-foreground">
        <div className="text-center">
          <Loader2 className="mx-auto size-5 animate-spin" />
          <p className="mt-2 text-xs">Reading the repository tree…</p>
        </div>
      </div>
    );
  }
  if (snapshot.isError || !snapshot.data || !display) {
    return (
      <div className="m-5 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        {snapshot.error instanceof Error
          ? snapshot.error.message
          : "The repository graph could not be loaded."}
      </div>
    );
  }

  const analysis = metrics.data?.analysis ?? snapshot.data.analysis;
  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden"
      data-slot="git-graph"
    >
      <RepositoryGraphSurface
        ariaLabel={`Repository graph for revision ${snapshot.data.revision?.slice(0, 8) ?? "unborn HEAD"}`}
        autoFit={!restoredOnMount}
        camera={state.camera}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent"
        maxVisibleNodes={4_000}
        nodes={display.nodes}
        rootNodeId={rootNodeId}
        selectedNodeId={state.selectedNodeId}
        onActivateNode={(node) => {
          if (node.kind === "file") {
            onActivateFile?.(node.path);
            return;
          }
          if (node.kind === "ghost" && commitRevision) {
            onOpenCommit?.(commitRevision);
            return;
          }
          if (node.kind !== "directory") return;
          setState((current) => ({
            ...current,
            focusedNodeId: node.id,
            selectedNodeId: node.id,
          }));
        }}
        onCameraChange={(camera) =>
          setState((current) => ({ ...current, camera }))
        }
        onSelectionChange={(node) =>
          setState((current) => ({
            ...current,
            selectedNodeId: node?.id ?? null,
          }))
        }
      />

      <div className="absolute left-3 top-3 flex max-w-[calc(100%-5.5rem)] flex-col gap-2">
        {commitRevision ? (
          <div className="flex w-fit max-w-full items-center gap-2 rounded-lg border border-violet-500/40 bg-background/92 px-3 py-2 text-xs shadow-sm backdrop-blur">
            <span className="shrink-0 font-medium text-violet-400">
              Commit {commitRevision.slice(0, 8)}
            </span>
            {commitOverlay.data ? (
              <span className="truncate text-muted-foreground">
                {commitOverlay.data.filesChanged.toLocaleString()} files · +
                {commitOverlay.data.additions.toLocaleString()} −
                {commitOverlay.data.deletions.toLocaleString()}
                {commitOverlay.data.truncated ? " · truncated" : ""}
              </span>
            ) : commitOverlay.isLoading ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            <Button
              className="ml-auto size-6 shrink-0"
              onClick={onClearCommit}
              size="icon"
              title="Back to HEAD"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
              <span className="sr-only">Back to HEAD</span>
            </Button>
          </div>
        ) : null}
        {commitOverlay.isError ? (
          <div className="w-fit max-w-full rounded-lg border border-destructive/30 bg-background/92 px-3 py-2 text-xs text-destructive shadow-sm backdrop-blur">
            {commitOverlay.error instanceof Error
              ? commitOverlay.error.message
              : "The selected commit overlay could not be loaded."}
          </div>
        ) : null}
        <details
          className="group w-fit max-w-full rounded-lg border bg-background/88 shadow-sm backdrop-blur"
          open
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium">
            <Network className="size-3.5" /> Graph dimensions
            <ChevronRight className="ml-auto size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          </summary>
          <div className="grid gap-2 border-t p-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Node size
              <select
                className="h-8 min-w-40 rounded-md border bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground"
                value={state.sizeDimension}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    sizeDimension: event.target.value as GitGraphSizeDimension,
                  }))
                }
              >
                {SIZE_DIMENSIONS.map((dimension) => (
                  <option
                    key={dimension.value}
                    disabled={dimensionDisabled(dimension.value, metricsReady)}
                    value={dimension.value}
                  >
                    {dimension.label}
                    {dimensionDisabled(dimension.value, metricsReady)
                      ? " (calculating)"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Node color
              <select
                className="h-8 min-w-40 rounded-md border bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground"
                disabled={Boolean(commitRevision)}
                value={state.colorDimension}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    colorDimension: event.target
                      .value as GitGraphColorDimension,
                  }))
                }
              >
                {COLOR_DIMENSIONS.map((dimension) => {
                  const unavailableBlame =
                    ["blame-owner", "blame-age"].includes(dimension.value) &&
                    analysis.blame !== "ready";
                  const disabled =
                    unavailableBlame ||
                    dimensionDisabled(dimension.value, metricsReady);
                  return (
                    <option
                      key={dimension.value}
                      disabled={disabled}
                      value={dimension.value}
                    >
                      {dimension.label}
                      {disabled
                        ? ` (${unavailableBlame ? metricStatusLabel(analysis.blame) : "calculating"})`
                        : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            {commitRevision ? (
              <p className="text-[10px] normal-case tracking-normal text-muted-foreground sm:col-span-2">
                The selected commit controls color and impact intensity. Your
                node-size dimension remains active.
              </p>
            ) : null}
          </div>
        </details>

        <nav
          aria-label="Graph scope"
          className="flex w-fit max-w-full items-center overflow-hidden rounded-md border bg-background/88 px-1 py-1 text-xs shadow-sm backdrop-blur"
        >
          {breadcrumbs.map((node, index) => (
            <span key={node.id} className="flex min-w-0 items-center">
              {index > 0 ? (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
              <button
                className="max-w-36 truncate rounded px-1.5 py-1 hover:bg-muted"
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    focusedNodeId:
                      node.id === snapshot.data.rootId ? null : node.id,
                  }))
                }
                type="button"
              >
                {node.name}
              </button>
            </span>
          ))}
        </nav>
        {onBack ||
        state.focusedNodeId ||
        (onRevealNode && selectedGraphNode) ? (
          <div className="flex w-fit items-center gap-1 rounded-md bg-background/88 shadow-sm backdrop-blur">
            {onBack ? (
              <Button
                className="h-8 gap-1.5 px-2.5"
                onClick={onBack}
                size="sm"
                title="Back to Explorer"
                type="button"
                variant="outline"
              >
                <ArrowLeft className="size-3.5" />
                Files
              </Button>
            ) : null}
            {onRevealNode && selectedGraphNode ? (
              <Button
                className="h-8 gap-1.5 px-2.5"
                onClick={() => onRevealNode(selectedGraphNode)}
                size="sm"
                title={`Reveal ${selectedGraphNode.path || selectedGraphNode.label} in Explorer`}
                type="button"
                variant="outline"
              >
                <LocateFixed className="size-3.5" />
                Reveal
              </Button>
            ) : null}
            {state.focusedNodeId ? (
              <Button
                className="size-8"
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    camera: DEFAULT_GIT_GRAPH_STATE.camera,
                    focusedNodeId: null,
                  }))
                }
                size="icon"
                title="Show the repository root"
                type="button"
                variant="outline"
              >
                <RotateCcw className="size-4" />
                <span className="sr-only">Show repository root</span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="absolute bottom-3 right-3 hidden min-w-52 grid-cols-2 gap-3 rounded-lg border bg-background/88 p-3 shadow-sm backdrop-blur sm:grid">
        <GraphLegend legend={display.sizeLegend} role="Size" />
        <GraphLegend legend={display.colorLegend} role="Color" />
      </div>

      <div className="absolute right-3 top-14 flex items-center gap-1 rounded-md border bg-background/88 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
        <span
          className={cn(
            "size-1.5 rounded-full",
            metrics.isFetching
              ? "animate-pulse bg-amber-500"
              : "bg-emerald-500",
          )}
        />
        {snapshot.data.totalNodes.toLocaleString()} nodes · lines{" "}
        {metricStatusLabel(analysis.lines)} · history{" "}
        {metricStatusLabel(analysis.history)}
      </div>
    </div>
  );
}
