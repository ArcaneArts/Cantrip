import type {
  AccountBandwidthChannel,
  AccountResourceUsageHistory,
} from "@cantrip/protocol";

export type AccountUsageRange = "24h" | "7d" | "30d" | "1y";

export interface AccountUsageHistoryWindow {
  from: string;
  resolution: "day" | "hour";
  to: string;
}

export interface AccountUsageChartPoint {
  at: string;
  value: bigint;
}

export interface AccountUsageChartSeries {
  color: string;
  id: string;
  label: string;
  points: AccountUsageChartPoint[];
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

export function formatUsageBytes(value: string | bigint): string {
  const bytes = typeof value === "bigint" ? value : BigInt(value);
  if (bytes < 1_024n) return `${bytes.toLocaleString()} B`;
  let divisor = 1n;
  let unitIndex = 0;
  while (unitIndex < BYTE_UNITS.length - 1 && bytes >= divisor * 1_024n) {
    divisor *= 1_024n;
    unitIndex += 1;
  }
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  const whole = tenths / 10n;
  const decimal = tenths % 10n;
  return `${whole.toLocaleString()}${decimal ? `.${decimal}` : ""} ${BYTE_UNITS[unitIndex]}`;
}

export function accountUsageHistoryWindow(
  range: AccountUsageRange,
  now = new Date(),
): AccountUsageHistoryWindow {
  const durationMs =
    range === "24h"
      ? 24 * 60 * 60_000
      : range === "7d"
        ? 7 * 24 * 60 * 60_000
        : range === "30d"
          ? 30 * 24 * 60 * 60_000
          : 365 * 24 * 60 * 60_000;
  const resolution = range === "24h" || range === "7d" ? "hour" : "day";
  const bucketMs = resolution === "hour" ? 60 * 60_000 : 24 * 60 * 60_000;
  const toMs = Math.ceil(now.getTime() / bucketMs) * bucketMs;
  return {
    from: new Date(toMs - durationMs).toISOString(),
    resolution,
    to: new Date(toMs).toISOString(),
  };
}

const storageLabels: Record<string, string> = {
  account: "Account",
  analytics: "Analytics & history",
  configuration: "Configuration",
  conversations: "Conversations",
  projects: "Projects & workspaces",
  attachments: "Attachment sources",
  "attachment-replicas": "Ready attachment replicas",
};

export function storageCategoryLabel(category: string): string {
  return (
    storageLabels[category] ??
    category
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

const bandwidthLabels: Record<AccountBandwidthChannel, string> = {
  http: "HTTP API",
  "client-live-websocket": "Client live updates",
  "worker-control-websocket": "Worker control",
  "worker-log-stream": "Worker logs",
  "terminal-relay": "Terminal relay",
  "remote-surface-relay": "Remote surfaces",
  "tunnel-relay": "Tunnel relay",
  "attachment-transfer": "Attachments",
  "code-relay": "Code relay",
  "project-share-relay": "Project sharing",
  other: "Other server traffic",
};

export function bandwidthChannelLabel(
  channel: AccountBandwidthChannel,
): string {
  return bandwidthLabels[channel];
}

function aggregatePoints(
  values: readonly { bucketStart: string; value: string }[],
): AccountUsageChartPoint[] {
  const buckets = new Map<string, bigint>();
  for (const point of values) {
    buckets.set(
      point.bucketStart,
      (buckets.get(point.bucketStart) ?? 0n) + BigInt(point.value),
    );
  }
  return [...buckets]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([at, value]) => ({ at, value }));
}

export function storageHistoryChartSeries(
  history: AccountResourceUsageHistory | undefined,
): AccountUsageChartSeries[] {
  if (!history || history.metric !== "storage") return [];
  return [
    {
      id: "server",
      label: "Logical server storage",
      color: "#22d3ee",
      points: aggregatePoints(
        history.series
          .filter(({ storageClass }) => storageClass === "server")
          .flatMap(({ points }) =>
            points.map((point) => ({
              bucketStart: point.bucketStart,
              value: point.logicalBytes,
            })),
          ),
      ),
    },
    {
      id: "worker-managed",
      label: "Known worker attachments",
      color: "#a78bfa",
      points: aggregatePoints(
        history.series
          .filter(({ storageClass }) => storageClass === "worker-managed")
          .flatMap(({ points }) =>
            points.map((point) => ({
              bucketStart: point.bucketStart,
              value: point.logicalBytes,
            })),
          ),
      ),
    },
  ].filter(({ points }) => points.length > 0);
}

export function bandwidthHistoryChartSeries(
  history: AccountResourceUsageHistory | undefined,
): AccountUsageChartSeries[] {
  if (!history || history.metric !== "bandwidth") return [];
  return [
    {
      id: "ingress",
      label: "Ingress",
      color: "#34d399",
      points: aggregatePoints(
        history.series
          .filter(({ direction }) => direction === "ingress")
          .flatMap(({ points }) =>
            points.map((point) => ({
              bucketStart: point.bucketStart,
              value: point.bytes,
            })),
          ),
      ),
    },
    {
      id: "egress",
      label: "Egress",
      color: "#fb7185",
      points: aggregatePoints(
        history.series
          .filter(({ direction }) => direction === "egress")
          .flatMap(({ points }) =>
            points.map((point) => ({
              bucketStart: point.bucketStart,
              value: point.bytes,
            })),
          ),
      ),
    },
  ].filter(({ points }) => points.length > 0);
}
