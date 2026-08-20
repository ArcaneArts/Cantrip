import type {
  GitGraphCommitOverlay,
  GitGraphMetrics,
  GitGraphNodeMetrics,
  GitGraphSnapshot,
} from "@cantrip/protocol";

import type { RepositoryGraphInputNode } from "@/components/repository-graph";

export type GitGraphSizeDimension =
  "equal" | "lines" | "bytes" | "commits" | "churn";

export type GitGraphColorDimension =
  | "language"
  | "commits"
  | "churn"
  | "last-change"
  | "creation-age"
  | "blame-owner"
  | "blame-age";

export type GitGraphLegend = {
  label: string;
  maximum: string | null;
  minimum: string | null;
  unavailable: boolean;
};

export type GitGraphDisplayModel = {
  colorLegend: GitGraphLegend;
  nodes: RepositoryGraphInputNode[];
  sizeLegend: GitGraphLegend;
};

const LANGUAGE_COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#fbbf24",
  "#60a5fa",
  "#e879f9",
  "#a3e635",
  "#fb923c",
];

const COMMIT_STATUS_COLORS: Record<
  GitGraphCommitOverlay["nodes"][number]["status"],
  string
> = {
  added: "#34d399",
  copied: "#22d3ee",
  deleted: "#fb7185",
  modified: "#fbbf24",
  renamed: "#a78bfa",
  "type-changed": "#fb923c",
  unmerged: "#f43f5e",
  unknown: "#94a3b8",
};

const EQUAL_NODE_RADIUS = 7;
const MIN_METRIC_NODE_RADIUS = 4;
const MAX_METRIC_NODE_RADIUS = 30;

function stableColor(category: string): string {
  let hash = 0;
  for (let index = 0; index < category.length; index += 1)
    hash = (hash * 31 + category.charCodeAt(index)) | 0;
  return LANGUAGE_COLORS[Math.abs(hash) % LANGUAGE_COLORS.length]!;
}

function metricMap(
  metrics: GitGraphMetrics | null,
): Map<string, GitGraphNodeMetrics> {
  return new Map(metrics?.nodes.map((metric) => [metric.nodeId, metric]) ?? []);
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)),
  );
  return Math.max(1, sorted[index] ?? 1);
}

function numericColor(value: number | null, maximum: number): string {
  if (value === null) return "#64748b";
  const normalized = Math.min(1, Math.max(0, value / Math.max(1, maximum)));
  const hue = 210 + normalized * 115;
  const lightness = 62 - normalized * 10;
  return `hsl(${hue} 78% ${lightness}%)`;
}

function daysBetween(now: number, value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, (now - timestamp) / 86_400_000)
    : null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${formatNumber(value / 1_024)} KB`;
  if (value < 1_073_741_824) return `${formatNumber(value / 1_048_576)} MB`;
  return `${formatNumber(value / 1_073_741_824)} GB`;
}

function sizeValue(
  dimension: GitGraphSizeDimension,
  byteSize: number | null,
  metric: GitGraphNodeMetrics | undefined,
): number | null {
  switch (dimension) {
    case "equal":
      return 1;
    case "bytes":
      return byteSize;
    case "lines":
      return metric?.lineCount ?? null;
    case "commits":
      return metric?.commitTouches ?? null;
    case "churn":
      return metric?.churn ?? null;
  }
}

function numericColorValue(
  dimension: GitGraphColorDimension,
  metric: GitGraphNodeMetrics | undefined,
  now: number,
): number | null {
  switch (dimension) {
    case "commits":
      return metric?.commitTouches ?? null;
    case "churn":
      return metric?.churn ?? null;
    case "last-change":
      return daysBetween(now, metric?.lastChangedAt ?? null);
    case "creation-age":
      return daysBetween(now, metric?.firstChangedAt ?? null);
    case "blame-age":
      return metric?.averageBlameAgeDays ?? null;
    case "language":
    case "blame-owner":
      return null;
  }
}

function sizeLabel(dimension: GitGraphSizeDimension): string {
  return {
    bytes: "File bytes",
    churn: "Cumulative churn",
    commits: "Commit touches",
    equal: "Equal size",
    lines: "Lines of code",
  }[dimension];
}

function colorLabel(dimension: GitGraphColorDimension): string {
  return {
    "blame-age": "Surviving line age",
    "blame-owner": "Current blame owner",
    churn: "Cumulative churn",
    commits: "Commit touches",
    "creation-age": "Age since creation",
    language: "Language or file type",
    "last-change": "Time since last change",
  }[dimension];
}

function formatDimensionValue(
  dimension: GitGraphSizeDimension | GitGraphColorDimension,
  value: number,
): string {
  if (dimension === "bytes") return formatBytes(value);
  if (
    dimension === "last-change" ||
    dimension === "creation-age" ||
    dimension === "blame-age"
  )
    return `${formatNumber(value)} days`;
  if (dimension === "equal") return "Equal";
  return formatNumber(value);
}

function description(
  node: GitGraphSnapshot["nodes"][number],
  metric: GitGraphNodeMetrics | undefined,
): string {
  const values = [
    node.language ?? node.extension ?? node.kind,
    node.byteSize === null ? null : formatBytes(node.byteSize),
    metric?.lineCount === null || metric?.lineCount === undefined
      ? null
      : `${metric.lineCount.toLocaleString()} lines`,
    metric ? `${metric.commitTouches.toLocaleString()} commits` : null,
    metric ? `${metric.churn.toLocaleString()} churn` : null,
    metric?.lastChangedAt
      ? `last changed ${new Date(metric.lastChangedAt).toLocaleDateString()}`
      : null,
    metric?.dominantAuthorName ? `owned by ${metric.dominantAuthorName}` : null,
    metric?.dominantAuthorShare === null ||
    metric?.dominantAuthorShare === undefined
      ? null
      : `${formatNumber(metric.dominantAuthorShare * 100)}% current lines`,
    metric?.averageBlameAgeDays === null ||
    metric?.averageBlameAgeDays === undefined
      ? null
      : `${formatNumber(metric.averageBlameAgeDays)} days average line age`,
  ].filter(Boolean);
  return values.join(" · ");
}

export function buildGitGraphDisplayModel(
  snapshot: GitGraphSnapshot,
  metrics: GitGraphMetrics | null,
  sizeDimension: GitGraphSizeDimension,
  colorDimension: GitGraphColorDimension,
  now = Date.now(),
): GitGraphDisplayModel {
  const metricsByNode = metricMap(metrics);
  const sizeValues = snapshot.nodes.map((node) =>
    sizeValue(sizeDimension, node.byteSize, metricsByNode.get(node.id)),
  );
  const numericColors = snapshot.nodes.map((node) =>
    numericColorValue(colorDimension, metricsByNode.get(node.id), now),
  );
  const sizeMaximum = percentile(
    sizeValues.filter((value): value is number => value !== null),
    0.95,
  );
  const colorMaximum = percentile(
    numericColors.filter((value): value is number => value !== null),
    0.95,
  );
  const nodes = snapshot.nodes.map((node, index) => {
    const metric = metricsByNode.get(node.id);
    const size = sizeValues[index] ?? null;
    const category =
      colorDimension === "blame-owner"
        ? (metric?.dominantAuthorEmail ??
          metric?.dominantAuthorName ??
          "Unknown")
        : (node.language ?? node.extension ?? node.kind);
    const color =
      colorDimension === "language" || colorDimension === "blame-owner"
        ? stableColor(category)
        : numericColor(numericColors[index] ?? null, colorMaximum);
    return {
      accessibleDescription: description(node, metric),
      color,
      id: node.id,
      kind: node.kind,
      label: node.name,
      parentId: node.parentId,
      path: node.path ?? "",
      radius:
        sizeDimension === "equal"
          ? EQUAL_NODE_RADIUS
          : size === null
            ? node.kind === "directory"
              ? 9
              : 5
            : MIN_METRIC_NODE_RADIUS +
              Math.sqrt(Math.min(1, Math.max(0, size / sizeMaximum))) *
                (MAX_METRIC_NODE_RADIUS - MIN_METRIC_NODE_RADIUS),
    } satisfies RepositoryGraphInputNode;
  });
  const availableSizes = sizeValues.filter(
    (value): value is number => value !== null,
  );
  const availableColors = numericColors.filter(
    (value): value is number => value !== null,
  );
  const categoricalColor =
    colorDimension === "language" || colorDimension === "blame-owner";
  return {
    nodes,
    sizeLegend: {
      label: sizeLabel(sizeDimension),
      maximum: availableSizes.length
        ? formatDimensionValue(
            sizeDimension,
            availableSizes.reduce((maximum, value) => Math.max(maximum, value)),
          )
        : null,
      minimum: availableSizes.length
        ? formatDimensionValue(
            sizeDimension,
            availableSizes.reduce((minimum, value) => Math.min(minimum, value)),
          )
        : null,
      unavailable: availableSizes.length === 0,
    },
    colorLegend: {
      label: colorLabel(colorDimension),
      maximum:
        !categoricalColor && availableColors.length
          ? formatDimensionValue(
              colorDimension,
              availableColors.reduce((maximum, value) =>
                Math.max(maximum, value),
              ),
            )
          : null,
      minimum:
        !categoricalColor && availableColors.length
          ? formatDimensionValue(
              colorDimension,
              availableColors.reduce((minimum, value) =>
                Math.min(minimum, value),
              ),
            )
          : null,
      unavailable:
        colorDimension === "blame-owner"
          ? !snapshot.nodes.some(
              (node) => metricsByNode.get(node.id)?.dominantAuthorName,
            )
          : !categoricalColor && availableColors.length === 0,
    },
  };
}

function nearestGraphParentId(
  path: string,
  pathToId: ReadonlyMap<string, string>,
  rootId: string,
): string {
  let separator = path.lastIndexOf("/");
  while (separator > 0) {
    const parentPath = path.slice(0, separator);
    const parentId = pathToId.get(parentPath);
    if (parentId) return parentId;
    separator = parentPath.lastIndexOf("/");
  }
  return rootId;
}

function commitChangeDescription(
  node: GitGraphCommitOverlay["nodes"][number],
): string {
  const changes =
    node.additions === null || node.deletions === null
      ? node.binary
        ? "binary change"
        : `${node.weight.toLocaleString()} changed lines`
      : `+${node.additions.toLocaleString()} −${node.deletions.toLocaleString()}`;
  const rename = node.originalPath ? ` from ${node.originalPath}` : "";
  return `${node.status}${rename} · ${changes}`;
}

function commitImpactColor(
  status: GitGraphCommitOverlay["nodes"][number]["status"],
  weight: number,
  maximum: number,
): string {
  const source = COMMIT_STATUS_COLORS[status];
  const intensity = 0.45 + 0.55 * Math.sqrt(Math.min(1, weight / maximum));
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(source.slice(offset, offset + 2), 16),
  );
  const subdued = [51, 65, 85];
  return `rgb(${channels
    .map((channel, index) =>
      Math.round(subdued[index]! * (1 - intensity) + channel! * intensity),
    )
    .join(" ")})`;
}

export function applyGitGraphCommitOverlay(
  display: GitGraphDisplayModel,
  snapshot: GitGraphSnapshot,
  overlay: GitGraphCommitOverlay,
): GitGraphDisplayModel {
  const overlayByPath = new Map(overlay.nodes.map((node) => [node.path, node]));
  const pathToId = new Map(
    snapshot.nodes
      .filter((node) => node.path !== null)
      .map((node) => [node.path!, node.id] as const),
  );
  const weights = overlay.nodes.map(({ weight }) => weight);
  const weightMaximum = percentile(weights, 0.95);
  const directoryImpact = new Map<
    string,
    { changedDescendants: number; weight: number }
  >();
  for (const node of snapshot.nodes) {
    if (node.kind !== "directory") continue;
    const changes = overlay.nodes.filter(
      (change) =>
        node.path === null ||
        change.path === node.path ||
        change.path.startsWith(`${node.path}/`),
    );
    if (!changes.length) continue;
    directoryImpact.set(node.id, {
      changedDescendants: changes.length,
      weight: changes.reduce((total, change) => total + change.weight, 0),
    });
  }
  const directoryWeightMaximum = percentile(
    [...directoryImpact.values()].map(({ weight }) => weight),
    0.95,
  );
  const presentPaths = new Set<string>();
  const nodes = display.nodes.map((node) => {
    const change = overlayByPath.get(node.path);
    if (!change) {
      const aggregate = directoryImpact.get(node.id);
      if (aggregate) {
        return {
          ...node,
          accessibleDescription: [
            node.accessibleDescription,
            `${aggregate.changedDescendants.toLocaleString()} changed descendants · ${aggregate.weight.toLocaleString()} changed lines`,
          ]
            .filter(Boolean)
            .join(" · "),
          color: commitImpactColor(
            "modified",
            aggregate.weight,
            directoryWeightMaximum,
          ),
        };
      }
      return {
        ...node,
        accessibleDescription: [
          node.accessibleDescription,
          "unchanged in selected commit",
        ]
          .filter(Boolean)
          .join(" · "),
        color: node.kind === "directory" ? "#475569" : "#334155",
      };
    }
    presentPaths.add(change.path);
    return {
      ...node,
      accessibleDescription: [
        node.accessibleDescription,
        commitChangeDescription(change),
      ]
        .filter(Boolean)
        .join(" · "),
      color: commitImpactColor(change.status, change.weight, weightMaximum),
    };
  });

  for (const change of overlay.nodes) {
    if (presentPaths.has(change.path) || !change.ghost) continue;
    const name = change.path.split("/").at(-1) ?? change.path;
    nodes.push({
      accessibleDescription: commitChangeDescription(change),
      color: commitImpactColor(change.status, change.weight, weightMaximum),
      id: `ghost:${overlay.revision}:${change.path}`,
      kind: "ghost",
      label: name,
      parentId: nearestGraphParentId(change.path, pathToId, snapshot.rootId),
      path: change.path,
      radius: 5 + Math.sqrt(Math.min(1, change.weight / weightMaximum)) * 18,
    });
  }

  const minimum = weights.length ? Math.min(...weights) : null;
  const maximum = weights.length ? Math.max(...weights) : null;
  return {
    nodes,
    sizeLegend: display.sizeLegend,
    colorLegend: {
      label: "Commit status / impact",
      minimum: minimum === null ? null : `${formatNumber(minimum)} changed`,
      maximum: maximum === null ? null : `${formatNumber(maximum)} changed`,
      unavailable: overlay.nodes.length === 0,
    },
  };
}

export function gitGraphDimensionNeedsMetrics(
  dimension: GitGraphSizeDimension | GitGraphColorDimension,
): boolean {
  return !["equal", "bytes", "language"].includes(dimension);
}
