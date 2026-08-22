import type { ChatMessage } from "@cantrip/protocol";
import {
  Check,
  ChevronDown,
  CircleX,
  Filter,
  Loader2,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  filterTrajectoryEvents,
  projectTrajectory,
  trajectoryEventKinds,
  trajectoryKindLabel,
  type TrajectoryEvent,
  type TrajectoryLane,
} from "./trajectory-model";

const TRAJECTORY_CLOCK_INTERVAL_MS = 500;
const lanes = ["input", "model", "tools"] as const;

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatOffset(event: TrajectoryEvent, startedAtMs: number): string {
  return `+${formatElapsed(Math.max(0, event.startMs - startedAtMs))}`;
}

function toggleSet<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function EventStatus({ event }: { event: TrajectoryEvent }) {
  if (event.status === "running") {
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  }
  if (event.status === "completed") {
    return <Check className="size-3.5 text-emerald-600" />;
  }
  return <CircleX className="size-3.5 text-destructive" />;
}

function laneColor(lane: TrajectoryLane): string {
  if (lane === "input") return "bg-sky-500";
  if (lane === "model") return "bg-violet-500";
  return "bg-amber-500";
}

function TrajectoryEventRow({
  event,
  startedAtMs,
}: {
  event: TrajectoryEvent;
  startedAtMs: number;
}) {
  return (
    <li
      className="flex min-w-0 gap-2.5 border-b px-3 py-2.5 last:border-b-0"
      data-event-id={event.id}
      data-event-kind={event.kind}
      data-event-lane={event.lane}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          laneColor(event.lane),
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {event.label}
          </span>
          <time className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatOffset(event, startedAtMs)}
          </time>
          <EventStatus event={event} />
        </div>
        {event.preview ? (
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {event.preview}
          </p>
        ) : null}
        <div className="mt-1 flex gap-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
          <span>{event.lane}</span>
          <span>{trajectoryKindLabel(event.kind)}</span>
          {event.timingQuality !== "exact" ? (
            <span>{event.timingQuality} timing</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function AgentTrajectory({
  active,
  messages,
  targetTurnKey,
  visible,
}: {
  active: boolean;
  messages: ChatMessage[];
  targetTurnKey?: string | null;
  visible: boolean;
}) {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [hiddenLanes, setHiddenLanes] = useState<Set<TrajectoryLane>>(
    () => new Set(),
  );
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setClockMs(Date.now());
  }, [active, messages, targetTurnKey, visible]);

  useEffect(() => {
    if (!active || !visible) return;
    const interval = window.setInterval(
      () => setClockMs(Date.now()),
      TRAJECTORY_CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [active, visible]);

  const nowMs = visible ? Math.max(clockMs, Date.now()) : clockMs;
  const turn = useMemo(
    () =>
      projectTrajectory({
        active,
        messages,
        nowMs,
        targetTurnKey,
      }),
    [active, messages, nowMs, targetTurnKey],
  );
  const kinds = useMemo(
    () => trajectoryEventKinds(turn?.events ?? []),
    [turn?.events],
  );
  const visibleKindCount = kinds.filter(
    (kind) => !hiddenKinds.has(kind),
  ).length;
  const events = useMemo(
    () =>
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenKinds,
        hiddenLanes,
        query,
      }),
    [hiddenKinds, hiddenLanes, query, turn?.events],
  );

  if (!turn) {
    return (
      <div
        className="grid h-full place-items-center p-6 text-center"
        data-slot="agent-trajectory-empty"
      >
        <div>
          <p className="text-sm font-medium">No turn available</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Start a turn to inspect its input, model, and tool activity.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-slot="agent-trajectory-content"
      data-turn-key={turn.key}
    >
      <header className="shrink-0 border-b px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium" title={turn.title}>
              {turn.title}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {turn.completed ? "Completed" : "Live"} ·{" "}
              {formatElapsed(turn.elapsedMs)}
              {!turn.exactTimingComplete ? " · mixed timing precision" : ""}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
            {turn.events.length} events
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5 text-[10px]">
          {lanes.map((lane) => (
            <button
              aria-pressed={!hiddenLanes.has(lane)}
              className={cn(
                "flex items-center justify-between rounded-md border px-2 py-1.5 capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                hiddenLanes.has(lane)
                  ? "text-muted-foreground opacity-50"
                  : "bg-muted/35 text-foreground",
              )}
              key={lane}
              onClick={() =>
                setHiddenLanes((current) => toggleSet(current, lane))
              }
              type="button"
            >
              <span>{lane}</span>
              <span className="tabular-nums text-muted-foreground">
                {turn.laneCounts[lane]}
              </span>
            </button>
          ))}
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search trajectory events"
            className="h-8 pl-7 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this turn"
            type="search"
            value={query}
          />
        </div>
        <details className="group relative">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2 text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <Filter className="size-3.5" /> Types
            {visibleKindCount < kinds.length ? (
              <span className="tabular-nums text-muted-foreground">
                {visibleKindCount}/{kinds.length}
              </span>
            ) : null}
            <ChevronDown className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="absolute right-0 z-20 mt-1 max-h-72 min-w-52 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
            <div className="mb-1 flex items-center justify-end gap-1">
              <Button
                className="h-6 px-2 text-[10px]"
                onClick={() => setHiddenKinds(new Set())}
                size="sm"
                type="button"
                variant="ghost"
              >
                All
              </Button>
              <Button
                className="h-6 px-2 text-[10px]"
                onClick={() => setHiddenKinds(new Set(kinds))}
                size="sm"
                type="button"
                variant="ghost"
              >
                None
              </Button>
            </div>
            {kinds.map((kind) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                key={kind}
              >
                <input
                  checked={!hiddenKinds.has(kind)}
                  onChange={() =>
                    setHiddenKinds((current) => toggleSet(current, kind))
                  }
                  type="checkbox"
                />
                <span>{trajectoryKindLabel(kind)}</span>
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {events.length > 0 ? (
          <ol aria-label="Trajectory events">
            {events.map((event) => (
              <TrajectoryEventRow
                event={event}
                key={event.id}
                startedAtMs={turn.startedAtMs}
              />
            ))}
          </ol>
        ) : (
          <div className="grid min-h-32 place-items-center p-5 text-center text-xs text-muted-foreground">
            No events match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}
