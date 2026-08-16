import type {
  ModelProfileSummary,
  ModelProviderSummary,
  ProviderTelemetryAnalytics,
  TelemetryBreakdown,
  TelemetryChangePoint,
  TelemetryQuotaReading,
  TelemetryValueStatistics,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock3,
  Download,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";

import { formatTokenCount } from "@/components/projects/token-usage-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteProviderTelemetryHistory,
  getProviderTelemetryAnalytics,
  getProviderTelemetryExport,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const colors = ["#22d3ee", "#a78bfa", "#34d399", "#fb7185", "#fbbf24"];

function formatPercent(value: number | null, digits = 1) {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatEstimate(value: number | null) {
  return value === null ? "Insufficient data" : `≈ ${formatTokenCount(value)}`;
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums">
        {value}
      </p>
      {detail ? (
        <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

function QuotaChart({
  readings,
}: {
  readings: readonly TelemetryQuotaReading[];
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, TelemetryQuotaReading[]>();
    for (const reading of readings) {
      grouped.set(reading.providerAccountId, [
        ...(grouped.get(reading.providerAccountId) ?? []),
        reading,
      ]);
    }
    return [...grouped.values()];
  }, [readings]);
  const timestamps = readings.map(({ observedAt }) => Date.parse(observedAt));
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const duration = Math.max(1, end - start);
  if (!readings.length) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        No meter history yet.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-background/25 p-2">
      <svg
        viewBox="0 0 800 150"
        className="h-36 w-full"
        role="img"
        aria-label="Historical provider usage percentage"
      >
        {[0, 25, 50, 75, 100].map((percent) => {
          const y = 138 - percent * 1.24;
          return (
            <g key={percent}>
              <line
                x1="30"
                x2="795"
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth="1"
              />
              <text
                x="2"
                y={y + 3}
                className="fill-muted-foreground text-[9px]"
              >
                {percent}%
              </text>
            </g>
          );
        })}
        {groups.map((group, groupIndex) => {
          const points = group
            .map((reading) => {
              const x =
                30 +
                ((Date.parse(reading.observedAt) - start) / duration) * 765;
              const y = 138 - reading.usedPercent * 1.24;
              return `${x},${y}`;
            })
            .join(" ");
          return (
            <polyline
              key={group[0]!.providerAccountId}
              points={points}
              fill="none"
              stroke={colors[groupIndex % colors.length]}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[10px] text-muted-foreground">
        {groups.map((group, index) => (
          <span
            key={group[0]!.providerAccountId}
            className="flex items-center gap-1.5"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: colors[index % colors.length] }}
            />
            {group[0]!.providerAccountLabel}
          </span>
        ))}
      </div>
    </div>
  );
}

function TokenMosaic({ analytics }: { analytics: ProviderTelemetryAnalytics }) {
  const days = useMemo(() => {
    const values = new Map(
      analytics.tokens.daily.map((day) => [day.date, day]),
    );
    const start = new Date(analytics.range.from);
    const end = new Date(analytics.range.to);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(0, 0, 0, 0);
    const result = [];
    for (
      const cursor = new Date(start);
      cursor <= end;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const date = cursor.toISOString().slice(0, 10);
      result.push(
        values.get(date) ?? {
          date,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      );
    }
    return result;
  }, [analytics]);
  const maximum = Math.max(0, ...days.map(({ totalTokens }) => totalTokens));
  return (
    <div className="overflow-x-auto pb-1">
      <div
        className="grid w-max grid-flow-col grid-rows-7 gap-1"
        aria-label="Daily token activity"
      >
        {days.map((day) => {
          const ratio = maximum ? day.totalTokens / maximum : 0;
          const opacity = ratio === 0 ? 0.08 : 0.2 + ratio * 0.8;
          return (
            <span
              key={day.date}
              className="size-2.5 rounded-[3px] bg-primary"
              style={{ opacity }}
              title={`${day.date}\n${day.totalTokens.toLocaleString()} tokens`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Confidence({ analytics }: { analytics: ProviderTelemetryAnalytics }) {
  const { estimates } = analytics;
  const confidence = estimates.sampleCount
    ? estimates.highConfidenceSamples / estimates.sampleCount
    : 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "rounded-full px-2 py-1",
          confidence >= 0.7
            ? "bg-emerald-500/15 text-emerald-500"
            : "bg-amber-500/15 text-amber-500",
        )}
      >
        {estimates.highConfidenceSamples}/{estimates.sampleCount}{" "}
        high-confidence samples
      </span>
      {estimates.unattributedSamples ? (
        <span>
          {estimates.unattributedSamples} unattributed meter movements
        </span>
      ) : null}
      <span>Observed estimates, not provider-published allowances.</span>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly TelemetryBreakdown[];
}) {
  return (
    <section className="min-w-0">
      <h3 className="px-2 py-2 text-xs font-semibold">{title}</h3>
      <div className="divide-y border-y">
        {rows.slice(0, 8).map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-2 py-1.5 text-xs"
          >
            <span className="truncate">{row.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {row.sampleCount} samples
            </span>
            <span className="min-w-24 text-right tabular-nums">
              {formatEstimate(row.effectiveTokensPer100Percent.median)}
            </span>
          </div>
        ))}
        {!rows.length ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No comparable samples.
          </p>
        ) : null}
      </div>
    </section>
  );
}

const changeMetricLabels: Record<TelemetryChangePoint["metric"], string> = {
  "tokens-per-percent": "Tokens per 1%",
  "effective-weekly-allowance": "Weekly allowance",
  "failure-rate": "Failure rate",
  "tool-error-rate": "Tool error rate",
  latency: "Latency",
  "compaction-frequency": "Compaction frequency",
  "completion-rate": "Completion rate",
  "output-reasoning-mix": "Reasoning / output mix",
};

function formatChangeValue(change: TelemetryChangePoint, value: number) {
  if (change.unit === "tokens") return formatTokenCount(value);
  if (change.unit === "milliseconds") return formatDuration(value);
  return `${(value * 100).toFixed(1)}%`;
}

function ChangePoints({
  analytics,
}: {
  analytics: ProviderTelemetryAnalytics;
}) {
  return (
    <section>
      <div className="flex items-end justify-between gap-3 pb-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="size-4" /> Detected changes
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Conservative before/after signals, not proof of a provider-side
            change.
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {analytics.changePoints.length} signals
        </span>
      </div>
      <div className="overflow-x-auto border-y">
        <div className="min-w-[760px] divide-y text-xs">
          <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,1fr)_minmax(12rem,1.2fr)_7rem_6rem_7rem] gap-3 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Metric</span>
            <span>Affected</span>
            <span>Before → after</span>
            <span className="text-right">Change</span>
            <span className="text-right">Samples</span>
            <span className="text-right">Detected</span>
          </div>
          {analytics.changePoints.map((change) => (
            <div
              key={change.id}
              className="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,1fr)_minmax(12rem,1.2fr)_7rem_6rem_7rem] gap-3 px-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    change.impact === "degradation"
                      ? "bg-destructive"
                      : change.impact === "improvement"
                        ? "bg-emerald-500"
                        : "bg-muted-foreground",
                  )}
                />
                <span className="truncate">
                  {changeMetricLabels[change.metric]}
                </span>
              </span>
              <span className="truncate text-muted-foreground">
                {[change.providerAccountLabel, change.modelLabel]
                  .filter(Boolean)
                  .join(" · ") || "Provider"}
              </span>
              <span className="truncate tabular-nums">
                {formatChangeValue(change, change.beforeValue)} →{" "}
                {formatChangeValue(change, change.afterValue)}
              </span>
              <span
                className={cn(
                  "text-right tabular-nums",
                  change.impact === "degradation" && "text-destructive",
                  change.impact === "improvement" && "text-emerald-500",
                )}
              >
                {change.relativeChangePercent === null
                  ? change.direction
                  : `${change.relativeChangePercent >= 0 ? "+" : ""}${change.relativeChangePercent.toFixed(1)}%`}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {change.beforeSampleCount}+{change.afterSampleCount} ·{" "}
                {change.confidence}
              </span>
              <span
                className="text-right text-muted-foreground"
                title={`${change.beforeStart} – ${change.afterEnd}`}
              >
                {new Date(change.detectedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
          {!analytics.changePoints.length ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              No change crossed the minimum effect and sample thresholds in this
              range.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Behavior({ analytics }: { analytics: ProviderTelemetryAnalytics }) {
  const behavior = analytics.behavior.total;
  const recentDays = analytics.behavior.daily.slice(-14).reverse();
  return (
    <section>
      <div className="grid divide-x border-y sm:grid-cols-4">
        <Metric
          label="Completion"
          value={formatPercent(behavior.completionRate)}
          detail={`${behavior.completedCount}/${behavior.attemptCount} attempts`}
        />
        <Metric
          label="Median duration"
          value={formatDuration(behavior.durationMs.median)}
          detail={`${behavior.failedCount} failed · ${behavior.interruptedCount} interrupted`}
        />
        <Metric
          label="First activity"
          value={formatDuration(behavior.timeToFirstActivityMs.median)}
          detail="Observed median"
        />
        <Metric
          label="Visible response"
          value={formatDuration(behavior.timeToVisibleResponseMs.median)}
          detail="Observed median"
        />
      </div>
      <div className="grid divide-x border-b sm:grid-cols-4">
        <Metric
          label="Tool errors"
          value={formatPercent(behavior.toolErrorRate)}
          detail={`${behavior.invalidToolCallCount}/${behavior.toolCallCount} calls`}
        />
        <Metric
          label="Retry / failover"
          value={behavior.retryFailoverCount.toLocaleString()}
          detail="Route attempts"
        />
        <Metric
          label="Compactions"
          value={behavior.compactionCount.toLocaleString()}
          detail={`${behavior.approvalRequestCount} approvals`}
        />
        <Metric
          label="Corrective follow-ups"
          value={behavior.immediateCorrectiveFollowupCount.toLocaleString()}
          detail="2-minute heuristic"
        />
      </div>
      {recentDays.length ? (
        <div className="mt-3 overflow-x-auto">
          <div className="min-w-[560px] divide-y border-y text-xs">
            <div className="grid grid-cols-[1fr_repeat(4,minmax(5rem,auto))] gap-3 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>Day</span>
              <span className="text-right">Attempts</span>
              <span className="text-right">Completion</span>
              <span className="text-right">Median</span>
              <span className="text-right">Tool errors</span>
            </div>
            {recentDays.map((day) => (
              <div
                key={day.date}
                className="grid grid-cols-[1fr_repeat(4,minmax(5rem,auto))] gap-3 px-2 py-1.5 tabular-nums"
              >
                <span>{day.date}</span>
                <span className="text-right">{day.attemptCount}</span>
                <span className="text-right">
                  {formatPercent(day.completionRate, 0)}
                </span>
                <span className="text-right">
                  {formatDuration(day.durationMs.median)}
                </span>
                <span className="text-right">
                  {formatPercent(day.toolErrorRate, 0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ProviderTelemetryDialog({
  models,
  onOpenChange,
  open,
  provider,
}: {
  models: readonly ModelProfileSummary[];
  onOpenChange(open: boolean): void;
  open: boolean;
  provider: ModelProviderSummary | null;
}) {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [days, setDays] = useState(90);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    enabled: open && Boolean(provider),
    queryFn: () =>
      getProviderTelemetryAnalytics({
        providerId: provider!.id,
        providerAccountId: accountId || undefined,
        modelId: modelId || undefined,
        reasoningEffort: reasoningEffort || undefined,
        days,
      }),
    queryKey: [
      "provider-telemetry",
      provider?.id,
      accountId,
      modelId,
      reasoningEffort,
      days,
    ],
  });
  const providerModels = models.filter((model) =>
    model.routes.some((route) => route.providerId === provider?.id),
  );
  const analytics = query.data;
  const latestReset = analytics?.resetBoundaries.at(-1);
  const deleteHistory = useMutation({
    mutationFn: () => deleteProviderTelemetryHistory(provider!.id),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["provider-telemetry"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Could not delete telemetry.",
      );
    },
  });
  const downloadExport = async () => {
    if (!provider) return;
    try {
      setActionError(null);
      const exported = await getProviderTelemetryExport(provider.id);
      const href = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${provider.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-telemetry.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not export telemetry.",
      );
    }
  };
  const confirmDelete = () => {
    if (
      provider &&
      window.confirm(
        `Permanently delete all retained quota, token, behavior, and catalog telemetry for ${provider.name}? Export it first if you may need it later.`,
      )
    ) {
      deleteHistory.mutate();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <Gauge className="size-4" /> {provider?.name ?? "Provider"}{" "}
                telemetry
              </DialogTitle>
              <DialogDescription>
                Historical meter, exact token, and objective runtime behavior
                observations.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => void downloadExport()}
                disabled={!provider}
                title="Export retained telemetry as JSON"
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-destructive hover:text-destructive"
                onClick={confirmDelete}
                disabled={!provider || deleteHistory.isPending}
                title="Delete retained telemetry"
              >
                {deleteHistory.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                onClick={() => query.refetch()}
                disabled={query.isFetching}
                title="Refresh telemetry"
              >
                <RefreshCw
                  className={cn("size-3.5", query.isFetching && "animate-spin")}
                />
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">All accounts</option>
              {provider?.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
            <select
              className="h-8 max-w-64 rounded-md border bg-background px-2 text-xs"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">All models</option>
              {providerModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
            >
              <option value="">All reasoning</option>
              {["none", "minimal", "low", "medium", "high", "xhigh"].map(
                (effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ),
              )}
            </select>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          {actionError ? (
            <p className="mt-2 text-xs text-destructive">{actionError}</p>
          ) : null}
        </DialogHeader>
        <div className="min-h-80 overflow-y-auto px-5 py-4">
          {query.isLoading ? (
            <div className="grid min-h-72 place-items-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          {query.isError ? (
            <div className="grid min-h-72 place-items-center text-sm text-destructive">
              Could not load provider telemetry.
            </div>
          ) : null}
          {analytics ? (
            <div className="grid gap-5">
              <section>
                <div className="flex items-center justify-between gap-3 pb-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Gauge className="size-4" /> Quota meter
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    {latestReset
                      ? `Latest reset boundary ${new Date(latestReset.resetsAt).toLocaleString()}`
                      : "No reset observed"}
                  </span>
                </div>
                <div className="grid divide-x border-y sm:grid-cols-4">
                  <Metric
                    label="Current used"
                    value={
                      analytics.currentQuota.length
                        ? `${analytics.currentQuota[0]!.usedPercent.toFixed(1)}%`
                        : "—"
                    }
                    detail={analytics.currentQuota[0]?.providerAccountLabel}
                  />
                  <Metric
                    label="Observed / 1%"
                    value={formatEstimate(
                      analytics.estimates.tokensPerPercent.median,
                    )}
                    detail={`${analytics.estimates.sampleCount} movements`}
                  />
                  <Metric
                    label="Effective 100%"
                    value={formatEstimate(
                      analytics.estimates.effectiveTokensPer100Percent.median,
                    )}
                    detail="Observed median"
                  />
                  <Metric
                    label="30-day change"
                    value={
                      analytics.comparisons.rolling30Days.changePercent === null
                        ? "—"
                        : `${analytics.comparisons.rolling30Days.changePercent >= 0 ? "+" : ""}${analytics.comparisons.rolling30Days.changePercent.toFixed(1)}%`
                    }
                    detail="Versus prior 30 days"
                  />
                </div>
                <div className="mt-3">
                  <QuotaChart readings={analytics.quotaHistory} />
                </div>
                <div className="mt-2">
                  <Confidence analytics={analytics} />
                </div>
              </section>

              <section>
                <h3 className="flex items-center gap-2 pb-2 text-sm font-semibold">
                  <Activity className="size-4" /> Token consumption
                </h3>
                <div className="grid divide-x border-y sm:grid-cols-5">
                  <Metric
                    label="Total"
                    value={formatTokenCount(analytics.tokens.total.totalTokens)}
                  />
                  <Metric
                    label="Input"
                    value={formatTokenCount(analytics.tokens.total.inputTokens)}
                  />
                  <Metric
                    label="Output"
                    value={formatTokenCount(
                      analytics.tokens.total.outputTokens,
                    )}
                  />
                  <Metric
                    label="Cached"
                    value={formatTokenCount(
                      analytics.tokens.total.cachedInputTokens,
                    )}
                  />
                  <Metric
                    label="Reasoning"
                    value={formatTokenCount(
                      analytics.tokens.total.reasoningOutputTokens,
                    )}
                  />
                </div>
                <div className="mt-3">
                  <TokenMosaic analytics={analytics} />
                </div>
              </section>

              <section>
                <h3 className="flex items-center gap-2 pb-2 text-sm font-semibold">
                  <Clock3 className="size-4" /> Model behavior
                </h3>
                <Behavior analytics={analytics} />
              </section>

              <ChangePoints analytics={analytics} />

              <div className="grid gap-4 lg:grid-cols-2">
                <BreakdownTable
                  title="Accounts"
                  rows={analytics.breakdowns.accounts}
                />
                <BreakdownTable
                  title="Models"
                  rows={analytics.breakdowns.models}
                />
                <BreakdownTable
                  title="Reasoning effort"
                  rows={analytics.breakdowns.reasoningEfforts}
                />
                <BreakdownTable
                  title="Months"
                  rows={analytics.breakdowns.months}
                />
              </div>
              <p className="flex items-start gap-2 border-t pt-3 text-[11px] text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Estimates
                describe what Cantrip observed between provider meter movements.
                They are not official quotas and become more reliable as
                exact-account, single-model samples accumulate.
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
