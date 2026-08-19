import type { GitGraphMetricState, GitGraphSnapshot } from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2, Network, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { RepositoryGraphSurface } from "@/components/repository-graph";
import { Button } from "@/components/ui/button";
import {
  getProjectWorktreeGraphMetrics,
  getProjectWorktreeGraphSnapshot,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import {
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
  projectId,
  refreshEpoch,
  rootPath = null,
  worktreeId,
  onStatusChange,
}: {
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
      refreshEpoch,
    ],
    queryFn: () =>
      getProjectWorktreeGraphSnapshot(projectId, worktreeId, {
        maxNodes: 100_000,
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
  const display = useMemo(
    () =>
      snapshot.data
        ? buildGitGraphDisplayModel(
            snapshot.data,
            metrics.data ?? null,
            sizeDimension,
            colorDimension,
          )
        : null,
    [colorDimension, metrics.data, sizeDimension, snapshot.data],
  );
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
      isFetching: snapshot.isFetching || metrics.isFetching,
      nodeCount: snapshot.data?.totalNodes ?? 0,
    });
  }, [metrics.isFetching, onStatusChange, snapshot.data, snapshot.isFetching]);

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

      {state.focusedNodeId ? (
        <Button
          className="absolute bottom-3 left-3 size-8"
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
  );
}
