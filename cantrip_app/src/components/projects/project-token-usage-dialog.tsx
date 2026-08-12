import type {
  ProjectTokenUsage,
  ProjectTokenUsageBreakdown,
} from "@cantrip/protocol";
import { ArrowDownToLine, ArrowUpFromLine, Coins } from "lucide-react";
import { useMemo } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
  formatTokenCount,
  tokenUsageCalendar,
  tokenUsageConicGradient,
  tokenUsageIntensity,
  tokenUsageSlices,
} from "./token-usage-analytics";

const dateLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function PieBreakdown({
  title,
  values,
}: {
  title: string;
  values: readonly ProjectTokenUsageBreakdown[];
}) {
  const slices = tokenUsageSlices(values);
  return (
    <section className="rounded-xl border bg-card/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {slices.length ? (
        <div className="mt-4 flex items-center gap-5">
          <div
            aria-label={`${title} token distribution`}
            className="relative size-28 shrink-0 rounded-full"
            style={{ background: tokenUsageConicGradient(slices) }}
          >
            <div className="absolute inset-[22%] grid place-items-center rounded-full bg-popover text-[10px] font-medium text-muted-foreground">
              Tokens
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            {slices.map((slice) => (
              <div
                key={`${slice.id ?? "other"}:${slice.name}`}
                className="flex min-w-0 items-center gap-2 text-xs"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: slice.color }}
                />
                <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatTokenCount(slice.totalTokens)} ·{" "}
                  {slice.percent.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">No usage yet.</p>
      )}
    </section>
  );
}

export function ProjectTokenUsageAnalytics({
  usage,
}: {
  usage: ProjectTokenUsage;
}) {
  const calendar = useMemo(() => tokenUsageCalendar(usage), [usage]);
  const maximum = Math.max(
    0,
    ...usage.daily.map(({ totalTokens }) => totalTokens),
  );

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card/60 p-4">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {formatTokenCount(usage.total.totalTokens)}
          </p>
        </div>
        <div className="rounded-xl border bg-card/60 p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDownToLine className="size-3.5" /> Input
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {formatTokenCount(usage.total.inputTokens)}
          </p>
        </div>
        <div className="rounded-xl border bg-card/60 p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowUpFromLine className="size-3.5" /> Output
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {formatTokenCount(usage.total.outputTokens)}
          </p>
        </div>
      </section>

      <section className="rounded-xl border bg-card/60 p-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">Daily activity</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {dateLabel.format(new Date(`${usage.range.start}T00:00:00Z`))} –{" "}
              {dateLabel.format(new Date(`${usage.range.end}T00:00:00Z`))}
            </p>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            Less
            {[0, 1, 2, 3, 4].map((level) => (
              <span
                key={level}
                className={cn(
                  "size-2.5 rounded-[3px]",
                  level === 0 && "bg-muted/50",
                  level === 1 && "bg-primary/20",
                  level === 2 && "bg-primary/40",
                  level === 3 && "bg-primary/65",
                  level === 4 && "bg-primary",
                )}
              />
            ))}
            More
          </div>
        </div>
        <div className="mt-4 overflow-x-auto pb-1">
          <div
            aria-label="Daily token usage"
            className="grid w-max grid-flow-col grid-rows-7 gap-1"
          >
            {calendar.map((day, index) =>
              day ? (
                <span
                  key={day.date}
                  aria-label={`${day.date}: ${day.totalTokens.toLocaleString()} tokens`}
                  title={`${day.date}\n${day.totalTokens.toLocaleString()} tokens (${day.inputTokens.toLocaleString()} input, ${day.outputTokens.toLocaleString()} output)`}
                  className={cn(
                    "size-2.5 rounded-[3px]",
                    tokenUsageIntensity(day.totalTokens, maximum) === 0 &&
                      "bg-muted/50",
                    tokenUsageIntensity(day.totalTokens, maximum) === 1 &&
                      "bg-primary/20",
                    tokenUsageIntensity(day.totalTokens, maximum) === 2 &&
                      "bg-primary/40",
                    tokenUsageIntensity(day.totalTokens, maximum) === 3 &&
                      "bg-primary/65",
                    tokenUsageIntensity(day.totalTokens, maximum) === 4 &&
                      "bg-primary",
                  )}
                />
              ) : (
                <span key={`empty:${index}`} className="size-2.5" />
              ),
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <PieBreakdown title="By provider" values={usage.providers} />
        <PieBreakdown title="By model" values={usage.models} />
      </div>
    </>
  );
}

export function ProjectTokenUsageDialog({
  onOpenChange,
  open,
  projectName,
  usage,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
  projectName: string;
  usage: ProjectTokenUsage;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="size-5" /> Token usage
          </DialogTitle>
          <DialogDescription>
            {projectName} · tracked across chats, workflows, and agent tools.
          </DialogDescription>
        </DialogHeader>
        <ProjectTokenUsageAnalytics usage={usage} />
      </DialogContent>
    </Dialog>
  );
}
