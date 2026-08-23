import type { ChatMessage } from "@cantrip/protocol";
import {
  ArrowDown,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleX,
  Filter,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { buildAgentTurnProjection } from "./agent-turn-projection";
import {
  filterTrajectoryEvents,
  projectTrajectory,
  trajectoryEventKinds,
  trajectoryKindLabel,
  type TrajectoryEvent,
  type TrajectoryLane,
} from "./trajectory-model";
import { TrajectoryDetails } from "./trajectory-details";
import type { TrajectoryTimingQuality } from "./trajectory-timing";
import {
  TrajectoryTimeline,
  trajectoryEventAtTime,
} from "./trajectory-timeline";
import { useStickyChatScroll } from "./use-sticky-chat-scroll";

const TRAJECTORY_CLOCK_INTERVAL_MS = 500;
const TRAJECTORY_FOLLOW_THRESHOLD_PX = 24;
const lanes = ["input", "model", "tools"] as const;
const statuses = ["running", "completed", "failed", "declined"] as const;
const timingQualities = ["exact", "derived", "instant"] as const;

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

function formatEventDuration(event: TrajectoryEvent): string {
  if (event.timingQuality === "instant") return "instant";
  return formatElapsed(Math.max(0, event.updatedAtMs - event.startMs));
}

function trajectoryStatus(turn: {
  completed: boolean;
  events: readonly TrajectoryEvent[];
}): string {
  const terminal = [...turn.events]
    .reverse()
    .find((event) => event.kind === "turnSummary");
  if (terminal?.status === "failed") return "Failed";
  if (terminal?.status === "declined") return "Declined";
  return turn.completed ? "Completed" : "Live";
}

function preferredScrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function toggleSet<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function trajectorySubagentTarget(
  event: TrajectoryEvent,
): { agentKey: string; focusItemKey: string | null } | null {
  return event.agentIsRoot
    ? null
    : { agentKey: event.agentKey, focusItemKey: event.focusItemKey };
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
  onSelect,
  onFocus,
  rowRef,
  selected,
  startedAtMs,
}: {
  event: TrajectoryEvent;
  onSelect(): void;
  onFocus(): void;
  rowRef(node: HTMLLIElement | null): void;
  selected: boolean;
  startedAtMs: number;
}) {
  return (
    <li
      data-agent-key={event.agentKey}
      className="min-w-0 border-b last:border-b-0"
      data-event-id={event.id}
      data-event-kind={event.kind}
      data-event-lane={event.lane}
      ref={rowRef}
    >
      <button
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full min-w-0 gap-2.5 px-3 py-2.5 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-muted/50",
        )}
        onClick={onSelect}
        onFocus={onFocus}
        type="button"
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
            <span className="sr-only">{event.status}</span>
          </div>
          {event.preview ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
              {event.preview}
            </p>
          ) : null}
          <div className="mt-1 flex gap-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
            <span
              className="max-w-28 truncate normal-case"
              title={event.agentLabel}
            >
              {event.agentLabel}
            </span>
            <span>{event.lane}</span>
            <span>{trajectoryKindLabel(event.kind)}</span>
            <span>{formatEventDuration(event)}</span>
            {event.timingQuality !== "exact" ? (
              <span>{event.timingQuality} timing</span>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

export function AgentTrajectory({
  active,
  messages,
  onBackToCurrent,
  onOpenSubagent,
  targetTurnKey,
  visible,
}: {
  active: boolean;
  messages: ChatMessage[];
  onBackToCurrent?(): void;
  onOpenSubagent?(agentKey: string, focusItemKey: string | null): void;
  targetTurnKey?: string | null;
  visible: boolean;
}) {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [followingLive, setFollowingLive] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(
    () => new Set(),
  );
  const [hiddenLanes, setHiddenLanes] = useState<Set<TrajectoryLane>>(
    () => new Set(),
  );
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());
  const [hiddenStatuses, setHiddenStatuses] = useState<
    Set<TrajectoryEvent["status"]>
  >(() => new Set());
  const [hiddenTimingQualities, setHiddenTimingQualities] = useState<
    Set<TrajectoryTimingQuality>
  >(() => new Set());
  const deferredMessages = useDeferredValue(messages);

  useEffect(() => {
    setClockMs(Date.now());
  }, [active, messages, targetTurnKey, visible]);

  const nowMs = visible ? Math.max(clockMs, Date.now()) : clockMs;
  const agentProjection = useMemo(
    () => buildAgentTurnProjection(deferredMessages),
    [deferredMessages],
  );
  const turn = useMemo(
    () =>
      projectTrajectory({
        active,
        agentProjection,
        messages: deferredMessages,
        nowMs,
        targetTurnKey,
      }),
    [active, agentProjection, deferredMessages, nowMs, targetTurnKey],
  );
  const {
    contentRef: eventListContentRef,
    onScroll: updateEventListScrollState,
    scrollToBottom: scrollEventsToBottom,
    showScrollToBottom: showScrollToLatestEvent,
    viewportRef: eventListViewportRef,
  } = useStickyChatScroll(
    turn?.key ?? targetTurnKey ?? "trajectory-empty",
    TRAJECTORY_FOLLOW_THRESHOLD_PX,
  );
  const trajectoryRunning = Boolean(turn?.nextTransitionAtMs);

  useEffect(() => {
    if (!active || !visible || !trajectoryRunning) return;
    const interval = window.setInterval(
      () => setClockMs(Date.now()),
      TRAJECTORY_CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [active, trajectoryRunning, visible]);

  useEffect(() => {
    if (followingLive && turn && !turn.completed) {
      setPlayheadMs(turn.timelineEndMs);
    }
  }, [followingLive, turn?.completed, turn?.timelineEndMs]);
  const kinds = useMemo(
    () => trajectoryEventKinds(turn?.events ?? []),
    [turn?.events],
  );
  const events = useMemo(
    () =>
      filterTrajectoryEvents(turn?.events ?? [], {
        hiddenAgents,
        hiddenKinds,
        hiddenLanes,
        hiddenStatuses,
        hiddenTimingQualities,
        query,
      }),
    [
      hiddenKinds,
      hiddenAgents,
      hiddenLanes,
      hiddenStatuses,
      hiddenTimingQualities,
      query,
      turn?.events,
    ],
  );
  const activeFilterCount =
    hiddenAgents.size +
    hiddenLanes.size +
    hiddenKinds.size +
    hiddenStatuses.size +
    hiddenTimingQualities.size +
    (query.trim() ? 1 : 0);
  const selectedEvent = useMemo(
    () =>
      selectedEventId
        ? (turn?.events.find((event) => event.id === selectedEventId) ?? null)
        : null,
    [selectedEventId, turn?.events],
  );

  useEffect(() => {
    setPlayheadMs(turn?.timelineStartMs ?? null);
    setFollowingLive(false);
    setSelectedEventId(null);
    setHiddenAgents(new Set());
  }, [turn?.key]);

  useEffect(() => {
    if (!selectedEventId || !turn) return;
    if (events.some((event) => event.id === selectedEventId)) return;
    setSelectedEventId(
      trajectoryEventAtTime(events, playheadMs ?? turn.timelineStartMs)?.id ??
        null,
    );
  }, [events, playheadMs, selectedEventId, turn]);

  const selectAndReveal = (event: TrajectoryEvent, nextPlayheadMs: number) => {
    const subagentTarget = trajectorySubagentTarget(event);
    if (subagentTarget && onOpenSubagent) {
      setFollowingLive(false);
      setPlayheadMs(nextPlayheadMs);
      setSelectedEventId(event.id);
      onOpenSubagent(subagentTarget.agentKey, subagentTarget.focusItemKey);
      return;
    }
    rowRefs.current.get(event.id)?.scrollIntoView({
      behavior: preferredScrollBehavior(),
      block: "center",
    });
    setFollowingLive(false);
    setPlayheadMs(nextPlayheadMs);
    setSelectedEventId(event.id);
  };

  const closeDetails = () => {
    const restoredEventId = selectedEventId;
    setSelectedEventId(null);
    if (!restoredEventId) return;
    window.requestAnimationFrame(() => {
      rowRefs.current.get(restoredEventId)?.scrollIntoView({
        behavior: preferredScrollBehavior(),
        block: "center",
      });
    });
  };

  const movePlayhead = (timeMs: number) => {
    if (!turn) return;
    const nextTimeMs = Math.min(
      turn.timelineEndMs,
      Math.max(turn.timelineStartMs, timeMs),
    );
    setFollowingLive(false);
    setPlayheadMs(nextTimeMs);
  };

  const resetFilters = () => {
    setHiddenAgents(new Set());
    setHiddenLanes(new Set());
    setHiddenKinds(new Set());
    setHiddenStatuses(new Set());
    setHiddenTimingQualities(new Set());
    setQuery("");
  };

  if (!turn) {
    return (
      <div
        className="grid h-full place-items-center p-6 text-center"
        data-slot="agent-trajectory-empty"
      >
        <div>
          <p className="text-sm font-medium">
            {targetTurnKey
              ? "Historical turn unavailable"
              : "No turn available"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {targetTurnKey
              ? "This turn is no longer present in the loaded chat history."
              : "Start a turn to inspect its input, model, and tool activity."}
          </p>
          {targetTurnKey && onBackToCurrent ? (
            <Button
              className="mt-3"
              onClick={onBackToCurrent}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowLeft className="size-3.5" /> Back to current
            </Button>
          ) : null}
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
              {targetTurnKey
                ? `Historical turn ${turn.ordinal} · ${trajectoryStatus(turn)}`
                : trajectoryStatus(turn)}{" "}
              · {formatElapsed(turn.elapsedMs)}
              {!turn.exactTimingComplete ? " · mixed timing precision" : ""}
            </p>
          </div>
          {targetTurnKey && onBackToCurrent ? (
            <Button
              aria-label="Back to current trajectory"
              className="h-7 shrink-0 px-2 text-[10px]"
              onClick={onBackToCurrent}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="size-3" /> Back to current
            </Button>
          ) : null}
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
            {turn.events.length} events
          </span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
            {turn.agents.length} agents
          </span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
            {turn.laneCounts.tools} tools
          </span>
          {!turn.completed ? (
            <Button
              aria-pressed={followingLive}
              className="ml-auto h-6 px-2 text-[10px]"
              onClick={() => {
                setFollowingLive(true);
                setSelectedEventId(null);
                setPlayheadMs(turn.timelineEndMs);
              }}
              size="sm"
              type="button"
              variant={followingLive ? "outline" : "ghost"}
            >
              Follow live
            </Button>
          ) : null}
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

      <div className="shrink-0 border-b bg-muted/10">
        <TrajectoryTimeline
          agents={turn.agents.filter((agent) => !hiddenAgents.has(agent.key))}
          events={events}
          onMovePlayhead={movePlayhead}
          onSelectEvent={selectAndReveal}
          playheadMs={playheadMs ?? turn.timelineStartMs}
          turn={turn}
        />
      </div>

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
            <Filter className="size-3.5" /> Filters
            {activeFilterCount > 0 ? (
              <span className="tabular-nums text-muted-foreground">
                {activeFilterCount}
              </span>
            ) : null}
            <ChevronDown className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="absolute right-0 z-20 mt-1 max-h-80 min-w-56 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
            <div className="mb-1 flex items-center justify-between gap-1">
              <p className="px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Agents
              </p>
              <div className="flex items-center gap-1">
                <Button
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setHiddenAgents(new Set())}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  All
                </Button>
                <Button
                  className="h-6 px-2 text-[10px]"
                  onClick={() =>
                    setHiddenAgents(
                      new Set(
                        turn.agents
                          .filter((agent) => !agent.root)
                          .map((agent) => agent.key),
                      ),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Root only
                </Button>
              </div>
            </div>
            {turn.agents.map((agent) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                key={agent.key}
                style={{ paddingLeft: 8 + Math.min(agent.depth, 5) * 10 }}
              >
                <input
                  checked={!hiddenAgents.has(agent.key)}
                  onChange={() =>
                    setHiddenAgents((current) => toggleSet(current, agent.key))
                  }
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 truncate">{agent.label}</span>
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agent.active
                      ? "bg-sky-500"
                      : agent.status === "failed" ||
                          agent.status === "interrupted"
                        ? "bg-destructive"
                        : "bg-emerald-500",
                  )}
                />
              </label>
            ))}
            <p className="mt-2 border-t px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Event types
            </p>
            <div className="mb-1 flex items-center justify-between gap-1">
              <span />
              <div className="flex items-center gap-1">
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
            <p className="mt-2 border-t px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Status
            </p>
            {statuses.map((status) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                key={status}
              >
                <input
                  checked={!hiddenStatuses.has(status)}
                  onChange={() =>
                    setHiddenStatuses((current) => toggleSet(current, status))
                  }
                  type="checkbox"
                />
                <span className="capitalize">{status}</span>
              </label>
            ))}
            <p className="mt-2 border-t px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Timing
            </p>
            {timingQualities.map((quality) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50"
                key={quality}
              >
                <input
                  checked={!hiddenTimingQualities.has(quality)}
                  onChange={() =>
                    setHiddenTimingQualities((current) =>
                      toggleSet(current, quality),
                    )
                  }
                  type="checkbox"
                />
                <span className="capitalize">{quality}</span>
              </label>
            ))}
          </div>
        </details>
        {activeFilterCount > 0 ? (
          <Button
            aria-label={`Clear ${activeFilterCount} active trajectory filters`}
            className="size-8 shrink-0"
            onClick={resetFilters}
            size="icon"
            title="Clear trajectory filters"
            type="button"
            variant="ghost"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className="h-full overflow-y-auto overscroll-contain"
          data-slot="trajectory-event-viewport"
          onScroll={updateEventListScrollState}
          ref={eventListViewportRef}
        >
          <div ref={eventListContentRef}>
            {selectedEvent ? (
              <TrajectoryDetails event={selectedEvent} onBack={closeDetails} />
            ) : events.length > 0 ? (
              <ol aria-label="Trajectory events">
                {events.map((event) => (
                  <TrajectoryEventRow
                    event={event}
                    key={event.id}
                    onFocus={() => movePlayhead(event.startMs)}
                    onSelect={() => selectAndReveal(event, event.startMs)}
                    rowRef={(node) => {
                      if (node) rowRefs.current.set(event.id, node);
                      else rowRefs.current.delete(event.id);
                    }}
                    selected={selectedEventId === event.id}
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
        {showScrollToLatestEvent && !selectedEvent ? (
          <Button
            aria-label="Scroll to latest trajectory event"
            className="absolute bottom-3 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full bg-popover text-popover-foreground shadow-lg backdrop-blur-xl"
            onClick={scrollEventsToBottom}
            size="icon"
            title="Scroll to latest trajectory event"
            type="button"
            variant="outline"
          >
            <ArrowDown className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
