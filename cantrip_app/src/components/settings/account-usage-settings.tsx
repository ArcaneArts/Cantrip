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
  Info,
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
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </dt>
      <dd
        className="mt-1.5 truncate text-xl font-semibold tabular-nums"
        title={value}
      >
        {value}
      </dd>
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
      <div className="grid h-44 place-items-center border-y px-4 text-center text-xs text-muted-foreground">
        No measured activity in this range yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden border-y py-2">
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

function UsageStorageTable({
  rows,
  title,
  countLabel,
}: {
  rows: { label: string; bytes: string; count: string }[];
  title: string;
  countLabel: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="border-b px-2 pb-2 text-sm font-semibold">{title}</h2>
      {rows.length ? (
        <table aria-label={title} className="w-full text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium">Category</th>
              <th className="px-2 py-2 text-right font-medium">{countLabel}</th>
              <th className="px-2 py-2 text-right font-medium">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map(({ label, bytes, count }) => (
              <tr key={label}>
                <th scope="row" className="px-2 py-2.5 font-medium">
                  {label}
                </th>
                <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                  {BigInt(count).toLocaleString()}
                </td>
                <td
                  className="px-2 py-2.5 text-right tabular-nums"
                  title={`${bytes} bytes`}
                >
                  {formatUsageBytes(bytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-2 py-4 text-xs text-muted-foreground">
          No storage totals yet.
        </p>
      )}
    </section>
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
      label: "Attachment sources",
      bytes: usage.storage.workerManaged.attachmentSources.logicalBytes,
      count: usage.storage.workerManaged.attachmentSources.objectCount,
    },
    {
      label: "Ready replicas",
      bytes: usage.storage.workerManaged.readyReplicas.logicalBytes,
      count: usage.storage.workerManaged.readyReplicas.objectCount,
    },
  ];

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-2">
      <UsageStorageTable
        countLabel="Rows"
        rows={categories.map(({ category, logicalBytes, rowCount }) => ({
          label: storageCategoryLabel(category),
          bytes: logicalBytes,
          count: rowCount,
        }))}
        title="Server storage by category"
      />
      <UsageStorageTable
        countLabel="Objects"
        rows={workerRows}
        title="Worker-managed attachments"
      />
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
    <section className="min-w-0">
      <h2 className="border-b px-2 pb-2 text-sm font-semibold">
        Today’s server traffic
      </h2>
      {sorted.length ? (
        <div className="overflow-x-auto">
          <table
            aria-label="Today’s server traffic"
            className="w-full text-left text-xs"
          >
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium">Channel</th>
                <th className="px-2 py-2 text-right font-medium">Received</th>
                <th className="px-2 py-2 text-right font-medium">Sent</th>
                <th className="px-2 py-2 text-right font-medium">Operations</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map(([channel, row]) => (
                <tr key={channel}>
                  <th scope="row" className="px-2 py-2.5 font-medium">
                    {bandwidthChannelLabel(channel)}
                  </th>
                  <td
                    className="px-2 py-2.5 text-right tabular-nums"
                    title={`${row.ingress} bytes`}
                  >
                    {formatUsageBytes(row.ingress)}
                  </td>
                  <td
                    className="px-2 py-2.5 text-right tabular-nums"
                    title={`${row.egress} bytes`}
                  >
                    {formatUsageBytes(row.egress)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                    {row.operations.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-2 py-4 text-xs text-muted-foreground">
          No server traffic today.
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
        <h1 className="text-base font-semibold">Account usage</h1>
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

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" /> Usage limits are not enforced.
      </p>

      {current.measurement.status === "stale" ? (
        <InlineAlert tone="warning" title="Storage measurement is stale">
          Storage totals were last updated more than two hours ago.
        </InlineAlert>
      ) : current.measurement.status === "unavailable" ? (
        <InlineAlert tone="warning" title="Storage totals are pending">
          The first server storage measurement is still pending.
        </InlineAlert>
      ) : null}

      <dl
        aria-label="Usage totals"
        className="grid grid-cols-2 gap-x-5 gap-y-4 border-y px-2 py-4 md:grid-cols-4"
      >
        <UsageMetric
          icon={<Database className="size-3.5" />}
          label="Server storage"
          value={formatUsageBytes(current.storage.server.logicalBytes)}
        />
        <UsageMetric
          icon={<HardDrive className="size-3.5" />}
          label="Attachments"
          value={formatUsageBytes(current.storage.workerManaged.logicalBytes)}
        />
        <UsageMetric
          icon={<ArrowDownToLine className="size-3.5" />}
          label="Data received today"
          value={formatUsageBytes(current.bandwidth.ingressBytes)}
        />
        <UsageMetric
          icon={<ArrowUpFromLine className="size-3.5" />}
          label="Data sent today"
          value={formatUsageBytes(current.bandwidth.egressBytes)}
        />
      </dl>

      <StorageBreakdown usage={current} />
      <BandwidthBreakdown usage={current} />

      <section className="border-t px-2 pt-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="size-4" /> History
            </h2>
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
                className="h-44 min-h-0 border-y"
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
                className="h-44 min-h-0 border-y"
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

      <details className="border-t px-2 pt-3 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer hover:text-foreground">
          Measurement details
        </summary>
        <p className="mt-2">
          Server storage includes retained records, including archived ones.
          Attachment sizes are estimates. Data totals cover traffic through this
          server. History uses{" "}
          {window.resolution === "hour" ? "hourly" : "daily"} UTC totals for
          traffic and snapshots for storage.
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt>Storage measured</dt>
          <dd>{formatTimestamp(current.measurement.measuredAt)}</dd>
          <dt>Storage reconciled</dt>
          <dd>{formatTimestamp(current.measurement.reconciledAt)}</dd>
          <dt>Traffic measured</dt>
          <dd>{formatTimestamp(current.bandwidth.measuredAt)}</dd>
          <dt>Retained rows</dt>
          <dd>{BigInt(current.storage.server.rowCount).toLocaleString()}</dd>
          <dt>Storage basis</dt>
          <dd>{current.measurement.basisVersion}</dd>
        </dl>
      </details>
    </div>
  );
}
