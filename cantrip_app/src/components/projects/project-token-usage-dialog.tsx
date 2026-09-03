import type {
  ProjectTokenUsage,
  ProjectTokenUsageBreakdown,
} from "@cantrip/protocol";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Brain,
  Clock3,
  Coins,
  DatabaseZap,
  X,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
  formatAgentTime,
  formatConcurrency,
  formatTokenCount,
  tokenUsageCalendar,
  tokenUsageConicGradient,
  tokenUsageIntensity,
  tokenUsageSlices,
} from "./token-usage-analytics";

function TimeBreakdown({
  title,
  values,
}: {
  title: string;
  values: readonly ProjectTokenUsageBreakdown[];
}) {
  const rows = [...values]
    .filter(({ agentTime }) => agentTime.agentTimeMs > 0)
    .sort(
      (left, right) => right.agentTime.agentTimeMs - left.agentTime.agentTimeMs,
    );
  return (
    <section className="rounded-xl border bg-card/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length ? (
        <div className="mt-3 divide-y">
          {rows.map((row) => (
            <div
              key={`${row.id ?? "other"}:${row.name}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2 text-xs"
            >
              <span className="truncate font-medium">{row.name}</span>
              <span className="tabular-nums">
                {formatAgentTime(row.agentTime.agentTimeMs)}
              </span>
              <span className="text-muted-foreground">Wall-clock time</span>
              <span className="tabular-nums text-muted-foreground">
                {formatAgentTime(row.agentTime.wallTimeMs)} ·{" "}
                {formatConcurrency(row.agentTime)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">No activity yet.</p>
      )}
    </section>
  );
}

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
        <div className="mt-4 grid min-w-0 justify-items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:justify-items-stretch">
          <div
            aria-label={`${title} token distribution`}
            className="relative size-28 shrink-0 rounded-full"
            style={{ background: tokenUsageConicGradient(slices) }}
          >
            <div className="absolute inset-[22%] grid place-items-center rounded-full bg-popover text-[10px] font-medium text-muted-foreground">
              Tokens
            </div>
          </div>
          <div className="w-full min-w-0 space-y-2">
            {slices.map((slice) => (
              <div
                key={`${slice.id ?? "other"}:${slice.name}`}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs"
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

type TokenUsageSection = "overview" | "activity" | "breakdowns";

const TOKEN_USAGE_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "breakdowns", label: "Breakdowns" },
] as const satisfies readonly {
  id: TokenUsageSection;
  label: string;
}[];

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
  const [section, setSection] = useState<TokenUsageSection>("overview");
  const sectionId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selectSection = (next: TokenUsageSection) => {
    setSection(next);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        aria-label="Token usage sections"
        className="grid shrink-0 grid-cols-3 border-b px-2 sm:px-6"
        role="tablist"
      >
        {TOKEN_USAGE_SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            aria-controls={`${sectionId}-${id}-panel`}
            aria-selected={section === id}
            className={cn(
              "h-11 min-w-0 truncate border-b-2 px-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              section === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            id={`${sectionId}-${id}-tab`}
            onClick={() => selectSection(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={scrollerRef}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 sm:px-6 sm:py-6"
      >
        <div
          aria-labelledby={`${sectionId}-${section}-tab`}
          className="min-w-0 space-y-4"
          id={`${sectionId}-${section}-panel`}
          role="tabpanel"
        >
          {section === "overview" ? (
            <>
              <section>
                <h3 className="flex items-center gap-2 pb-2 text-sm font-semibold">
                  <Clock3 className="size-4" /> AI active time
                </h3>
                <div className="grid divide-y border-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <div className="px-3 py-3">
                    <p className="text-xs text-muted-foreground">Agent time</p>
                    <p className="mt-2 text-lg font-semibold tabular-nums">
                      {formatAgentTime(usage.agentTime.agentTimeMs)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Every agent counted independently
                    </p>
                  </div>
                  <div className="px-3 py-3">
                    <p className="text-xs text-muted-foreground">
                      Wall-clock time
                    </p>
                    <p className="mt-2 text-lg font-semibold tabular-nums">
                      {formatAgentTime(usage.agentTime.wallTimeMs)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Overlapping agents merged
                    </p>
                  </div>
                  <div className="px-3 py-3">
                    <p className="text-xs text-muted-foreground">
                      Average concurrency
                    </p>
                    <p className="mt-2 text-lg font-semibold tabular-nums">
                      {formatConcurrency(usage.agentTime)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {usage.agentTime.activeAgentCount
                        ? `${usage.agentTime.activeAgentCount} active now`
                        : "No agents active now"}
                    </p>
                  </div>
                </div>
              </section>

              <section className="grid min-w-0 grid-cols-2 border-y sm:grid-cols-5 sm:divide-x">
                <div className="min-w-0 px-3 py-3">
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatTokenCount(usage.total.totalTokens)}
                  </p>
                </div>
                <div className="min-w-0 px-3 py-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ArrowDownToLine className="size-3.5" /> Input
                  </p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatTokenCount(usage.total.inputTokens)}
                  </p>
                </div>
                <div className="min-w-0 px-3 py-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ArrowUpFromLine className="size-3.5" /> Output
                  </p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatTokenCount(usage.total.outputTokens)}
                  </p>
                </div>
                <div className="min-w-0 px-3 py-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <DatabaseZap className="size-3.5" /> Cached input
                  </p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatTokenCount(usage.total.cachedInputTokens)}
                  </p>
                </div>
                <div className="min-w-0 px-3 py-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Brain className="size-3.5" /> Reasoning
                  </p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatTokenCount(usage.total.reasoningOutputTokens)}
                  </p>
                </div>
              </section>
            </>
          ) : null}

          {section === "activity" ? (
            <section className="min-w-0 rounded-xl border bg-card/60 p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Daily activity</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateLabel.format(
                      new Date(`${usage.range.start}T00:00:00Z`),
                    )}{" "}
                    –{" "}
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
              <div
                aria-label="Daily token usage"
                className="mt-4 grid w-full min-w-0 grid-flow-col auto-cols-fr grid-rows-7 gap-px sm:gap-1"
              >
                {calendar.map((day, index) =>
                  day ? (
                    <span
                      key={day.date}
                      aria-label={`${day.date}: ${day.totalTokens.toLocaleString()} tokens`}
                      title={`${day.date}\n${day.totalTokens.toLocaleString()} tokens (${day.inputTokens.toLocaleString()} input, ${day.outputTokens.toLocaleString()} output)`}
                      className={cn(
                        "aspect-square w-full min-w-0 rounded-[1px] sm:rounded-[3px]",
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
                    <span
                      key={`empty:${index}`}
                      className="aspect-square w-full min-w-0"
                    />
                  ),
                )}
              </div>
            </section>
          ) : null}

          {section === "breakdowns" ? (
            <>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <PieBreakdown title="By provider" values={usage.providers} />
                <PieBreakdown title="By model" values={usage.models} />
              </div>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <TimeBreakdown
                  title="AI time by provider"
                  values={usage.providers}
                />
                <TimeBreakdown title="AI time by model" values={usage.models} />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
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
      <DialogContent
        className="h-[calc(100dvh-2rem)] min-w-0 max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(48rem,calc(100dvh-2rem))]"
        showClose={false}
      >
        <DialogHeader className="shrink-0 border-b pb-4 pl-4 pr-14 pt-5 sm:pl-6 sm:pr-16 sm:pt-6">
          <DialogTitle className="flex items-center gap-2">
            <Coins className="size-5" /> Token usage
          </DialogTitle>
          <DialogDescription>
            {projectName} · tracked across agents, tasks, and agent tools.
          </DialogDescription>
        </DialogHeader>
        <DialogClose
          aria-label="Close token usage"
          className="absolute right-2 top-2 z-10 grid size-10 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:right-4 sm:top-4"
        >
          <X className="size-5" />
        </DialogClose>
        <ProjectTokenUsageAnalytics usage={usage} />
      </DialogContent>
    </Dialog>
  );
}
