import type {
  AccountBandwidthChannel,
  AccountResourceUsage,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  HardDrive,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContentLoading } from "@/components/ui/content-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  getAccountResourceUsage,
  getAccountResourceUsageHistory,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { errorMessage } from "@/lib/error-message";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";

import {
  accountUsageHistoryWindow,
  bandwidthChannelLabel,
  bandwidthHistoryChartSeries,
  formatUsageBytes,
  storageCategoryLabel,
  storageHistoryChartSeries,
  type AccountUsageChartSeries,
  type AccountUsageRange,
} from "./account-usage-display";

const rangeOptions: readonly { id: AccountUsageRange; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "1y", label: "1 year" },
];

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
});

function formatTimestamp(value: string | null): string {
  return value ? dateTimeFormatter.format(new Date(value)) : "Not measured yet";
}

function UsageMetric({
  detail,
  icon,
  label,
  value,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card/60 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p
        className="mt-3 truncate text-xl font-semibold tabular-nums"
        title={value}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function chartCoordinates(
  series: AccountUsageChartSeries,
  start: number,
  duration: number,
  maximum: bigint,
): string {
  return series.points
    .map((point) => {
      const at = Date.parse(point.at);
      const x = 44 + ((at - start) / duration) * 744;
      const scaled =
        maximum > 0n ? Number((point.value * 100_000n) / maximum) : 0;
      const y = 128 - (scaled / 100_000) * 108;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function UsageHistoryChart({
  ariaLabel,
  series,
}: {
  ariaLabel: string;
  series: AccountUsageChartSeries[];
}) {
  const timestamps = series.flatMap(({ points }) =>
    points.map(({ at }) => Date.parse(at)).filter(Number.isFinite),
  );
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const duration = Math.max(1, end - start);
  const maximum = series.reduce(
    (largest, item) =>
      item.points.reduce(
        (seriesLargest, point) =>
          point.value > seriesLargest ? point.value : seriesLargest,
        largest,
      ),
    0n,
  );

  if (!series.length || !timestamps.length || maximum === 0n) {
    return (
      <div className="grid h-44 place-items-center rounded-lg border bg-background/25 px-4 text-center text-xs text-muted-foreground">
        No measured activity in this range yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background/25 p-2">
      <svg
        aria-label={ariaLabel}
        className="h-44 w-full"
        role="img"
        viewBox="0 0 800 150"
      >
        <title>{ariaLabel}</title>
        {[20, 74, 128].map((y) => (
          <line
            key={y}
            className="stroke-border"
            strokeWidth="1"
            x1="44"
            x2="788"
            y1={y}
            y2={y}
          />
        ))}
        <text className="fill-muted-foreground text-[9px]" x="2" y="23">
          {formatUsageBytes(maximum)}
        </text>
        <text className="fill-muted-foreground text-[9px]" x="25" y="131">
          0 B
        </text>
        {series.map((item) => (
          <polyline
            key={item.id}
            fill="none"
            points={chartCoordinates(item, start, duration, maximum)}
            stroke={item.color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex items-center justify-between gap-4 px-1 text-[10px] text-muted-foreground">
        <span>{shortDateFormatter.format(new Date(start))}</span>
        <span>{shortDateFormatter.format(new Date(end))}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[10px] text-muted-foreground">
        {series.map((item) => (
          <span key={item.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function StorageBreakdown({ usage }: { usage: AccountResourceUsage }) {
  const categories = [...usage.storage.server.categories].sort((left, right) =>
    BigInt(left.logicalBytes) === BigInt(right.logicalBytes)
      ? left.category.localeCompare(right.category)
      : BigInt(left.logicalBytes) > BigInt(right.logicalBytes)
        ? -1
        : 1,
  );
  const workerRows = [
    {
      id: "sources",
      label: "Attachment sources",
      bytes: usage.storage.workerManaged.attachmentSources.logicalBytes,
      count: usage.storage.workerManaged.attachmentSources.objectCount,
    },
    {
      id: "replicas",
      label: "Ready replicas",
      bytes: usage.storage.workerManaged.readyReplicas.logicalBytes,
      count: usage.storage.workerManaged.readyReplicas.objectCount,
    },
  ];

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <section className="min-w-0 rounded-xl border bg-card/60">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Server storage by category</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Active logical PostgreSQL row bytes. Archived records still count
            while retained.
          </p>
        </div>
        {categories.length ? (
          <div className="divide-y">
            {categories.map((category) => (
              <div
                key={category.category}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 py-2.5 text-xs"
              >
                <span className="truncate font-medium">
                  {storageCategoryLabel(category.category)}
                </span>
                <span
                  className="tabular-nums"
                  title={`${category.logicalBytes} bytes`}
                >
                  {formatUsageBytes(category.logicalBytes)}
                </span>
                <span className="text-muted-foreground">Logical rows</span>
                <span className="tabular-nums text-muted-foreground">
                  {BigInt(category.rowCount).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No reconciled server rows yet.
          </p>
        )}
      </section>

      <section className="min-w-0 rounded-xl border bg-card/60">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Worker-managed attachments</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Server-known logical estimates from attachment metadata.
            Repositories, worktrees, and arbitrary worker files are not scanned.
          </p>
        </div>
        <div className="divide-y">
          {workerRows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 py-2.5 text-xs"
            >
              <span className="truncate font-medium">{row.label}</span>
              <span className="tabular-nums" title={`${row.bytes} bytes`}>
                {formatUsageBytes(row.bytes)}
              </span>
              <span className="text-muted-foreground">Known objects</span>
              <span className="tabular-nums text-muted-foreground">
                {BigInt(row.count).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BandwidthBreakdown({ usage }: { usage: AccountResourceUsage }) {
  const rows = new Map<
    AccountBandwidthChannel,
    { ingress: bigint; egress: bigint; operations: bigint }
  >();
  for (const item of usage.bandwidth.breakdown) {
    const row = rows.get(item.channel) ?? {
      ingress: 0n,
      egress: 0n,
      operations: 0n,
    };
    row[item.direction] += BigInt(item.bytes);
    row.operations += BigInt(item.operationCount);
    rows.set(item.channel, row);
  }
  const sorted = [...rows].sort(([, left], [, right]) => {
    const leftTotal = left.ingress + left.egress;
    const rightTotal = right.ingress + right.egress;
    return leftTotal === rightTotal ? 0 : rightTotal > leftTotal ? 1 : -1;
  });

  return (
    <section className="min-w-0 rounded-xl border bg-card/60">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Today’s server bandwidth</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Encoded application payload crossing server boundaries. Direct local
          and WebRTC traffic is excluded.
        </p>
      </div>
      {sorted.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <thead className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Channel</th>
                <th className="px-4 py-2 text-right font-medium">Ingress</th>
                <th className="px-4 py-2 text-right font-medium">Egress</th>
                <th className="px-4 py-2 text-right font-medium">Operations</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map(([channel, row]) => (
                <tr key={channel}>
                  <th className="px-4 py-2.5 font-medium">
                    {bandwidthChannelLabel(channel)}
                  </th>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums"
                    title={`${row.ingress} bytes`}
                  >
                    {formatUsageBytes(row.ingress)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums"
                    title={`${row.egress} bytes`}
                  >
                    {formatUsageBytes(row.egress)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {row.operations.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No server bandwidth has been metered today.
        </p>
      )}
    </section>
  );
}

export function AccountUsageSettings() {
  const liveStatus = useAppLiveStatus();
  const resourcesLive = liveStatus === "live";
  const [range, setRange] = useState<AccountUsageRange>("30d");
  const window = useMemo(() => accountUsageHistoryWindow(range), [range]);
  const fallbackInterval = liveResourceRefreshInterval(resourcesLive, 60_000);
  const usage = useQuery({
    queryFn: getAccountResourceUsage,
    queryKey: ["account-resource-usage"],
    refetchInterval: fallbackInterval,
  });
  const storageHistory = useQuery({
    queryFn: () =>
      getAccountResourceUsageHistory({
        metric: "storage",
        ...window,
      }),
    queryKey: ["account-resource-usage-history", "storage", window],
    refetchInterval: fallbackInterval,
  });
  const bandwidthHistory = useQuery({
    queryFn: () =>
      getAccountResourceUsageHistory({
        metric: "bandwidth",
        ...window,
      }),
    queryKey: ["account-resource-usage-history", "bandwidth", window],
    refetchInterval: fallbackInterval,
  });
  const storageSeries = useMemo(
    () => storageHistoryChartSeries(storageHistory.data),
    [storageHistory.data],
  );
  const bandwidthSeries = useMemo(
    () => bandwidthHistoryChartSeries(bandwidthHistory.data),
    [bandwidthHistory.data],
  );

  if (usage.isPending) {
    return <ContentLoading label="Loading account usage…" />;
  }
  if (usage.isError || !usage.data) {
    return (
      <div className="grid min-h-64 place-items-center">
        <InlineAlert
          className="max-w-lg"
          error={usage.error}
          fallback="Could not load account usage."
          tone="error"
          title="Account usage unavailable"
        >
          <div className="grid gap-3">
            <span>
              {errorMessage(usage.error, "Could not load account usage.")}
            </span>
            <Button
              className="w-fit"
              size="sm"
              variant="outline"
              onClick={() => void usage.refetch()}
            >
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        </InlineAlert>
      </div>
    );
  }

  const current = usage.data;
  const historyError = storageHistory.error ?? bandwidthHistory.error;
  const historiesLoading =
    storageHistory.isPending || bandwidthHistory.isPending;

  return (
    <div className="grid w-full gap-4 pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Account usage</h1>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            Reconciled logical storage and metered application payload carried
            by this Cantrip server.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            {resourcesLive ? (
              <Wifi className="size-3 text-emerald-500" />
            ) : (
              <WifiOff className="size-3 text-amber-500" />
            )}
            {resourcesLive ? "Live updates" : "Fallback refresh"}
          </Badge>
          {(usage.isFetching ||
            storageHistory.isFetching ||
            bandwidthHistory.isFetching) && (
            <Loader2
              aria-label="Refreshing usage"
              className="size-3.5 animate-spin text-muted-foreground"
            />
          )}
          <Button
            aria-label="Refresh account usage"
            className="size-8"
            size="icon"
            title="Refresh account usage"
            variant="ghost"
            onClick={() => {
              void usage.refetch();
              void storageHistory.refetch();
              void bandwidthHistory.refetch();
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </header>

      <InlineAlert title="Usage limits are not enforced">
        These measurements are informational infrastructure for future limits.
        They are not billing-grade totals and do not reject requests or reserve
        storage.
      </InlineAlert>

      {current.measurement.status === "stale" ? (
        <InlineAlert tone="warning" title="Storage measurement is stale">
          The last successful storage reconciliation is older than two hours.
          Bandwidth may continue updating independently.
        </InlineAlert>
      ) : current.measurement.status === "unavailable" ? (
        <InlineAlert tone="warning" title="Storage baseline is not ready">
          The server has not completed its first storage reconciliation. Storage
          values are temporarily incomplete.
        </InlineAlert>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <UsageMetric
          detail={`${BigInt(current.storage.server.rowCount).toLocaleString()} retained rows`}
          icon={<Database className="size-3.5" />}
          label="Logical server storage"
          value={formatUsageBytes(current.storage.server.logicalBytes)}
        />
        <UsageMetric
          detail="Known attachment sources and ready replicas"
          icon={<HardDrive className="size-3.5" />}
          label="Worker-managed attachments"
          value={formatUsageBytes(current.storage.workerManaged.logicalBytes)}
        />
        <UsageMetric
          detail="Application payload received by the server today"
          icon={<ArrowDownToLine className="size-3.5" />}
          label="Bandwidth ingress"
          value={formatUsageBytes(current.bandwidth.ingressBytes)}
        />
        <UsageMetric
          detail="Application payload sent by the server today"
          icon={<ArrowUpFromLine className="size-3.5" />}
          label="Bandwidth egress"
          value={formatUsageBytes(current.bandwidth.egressBytes)}
        />
      </section>

      <StorageBreakdown usage={current} />
      <BandwidthBreakdown usage={current} />

      <section className="rounded-xl border bg-card/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="size-4" /> History
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              UTC {window.resolution === "hour" ? "hourly" : "daily"} buckets.
              Storage is a point-in-time state; bandwidth is summed within each
              bucket.
            </p>
          </div>
          <div
            aria-label="Usage history range"
            className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-1"
            role="group"
          >
            {rangeOptions.map((option) => (
              <Button
                key={option.id}
                aria-pressed={range === option.id}
                className="h-7 px-2.5 text-xs"
                size="sm"
                variant={range === option.id ? "outline" : "ghost"}
                onClick={() => setRange(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {historyError ? (
          <InlineAlert
            className="mt-4"
            error={historyError}
            fallback="Some usage history could not be loaded."
            size="sm"
            tone="warning"
            title="Partial history"
          >
            {errorMessage(
              historyError,
              "Some usage history could not be loaded.",
            )}
          </InlineAlert>
        ) : null}
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-medium">Storage history</h3>
            {historiesLoading && !storageHistory.data ? (
              <ContentLoading
                className="h-44 min-h-0 rounded-lg border"
                label="Loading storage history…"
              />
            ) : (
              <UsageHistoryChart
                ariaLabel="Historical account storage in bytes"
                series={storageSeries}
              />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-medium">Bandwidth history</h3>
            {historiesLoading && !bandwidthHistory.data ? (
              <ContentLoading
                className="h-44 min-h-0 rounded-lg border"
                label="Loading bandwidth history…"
              />
            ) : (
              <UsageHistoryChart
                ariaLabel="Historical server bandwidth in bytes"
                series={bandwidthSeries}
              />
            )}
          </div>
        </div>
      </section>

      <footer className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <span>Measured: {formatTimestamp(current.measurement.measuredAt)}</span>
        <span className="sm:text-right">
          Reconciled: {formatTimestamp(current.measurement.reconciledAt)}
        </span>
        <span>Storage basis: {current.measurement.basisVersion}</span>
        <span className="sm:text-right">
          Bandwidth updated: {formatTimestamp(current.bandwidth.measuredAt)}
        </span>
      </footer>
    </div>
  );
}
