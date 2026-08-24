import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

import type {
  TrajectoryAgent,
  TrajectoryEvent,
  TrajectoryLane,
  TrajectoryTurn,
} from "./trajectory-model";

const SVG_WIDTH = 1_000;
const TRACK_HEIGHT = 28;
const MAX_VISIBLE_TRACKS = 5;
const PLOT_LEFT = 0;
const PLOT_RIGHT = 0;

interface TimelineMark {
  count: number;
  event: TrajectoryEvent;
  width: number;
  x: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function trajectoryTimeAtClientX(input: {
  clientX: number;
  left: number;
  timelineEndMs: number;
  timelineStartMs: number;
  width: number;
}): number {
  const plotLeft = input.left + input.width * (PLOT_LEFT / SVG_WIDTH);
  const plotWidth =
    input.width * ((SVG_WIDTH - PLOT_LEFT - PLOT_RIGHT) / SVG_WIDTH);
  const progress = clamp(
    (input.clientX - plotLeft) / Math.max(1, plotWidth),
    0,
    1,
  );
  return (
    input.timelineStartMs +
    progress * (input.timelineEndMs - input.timelineStartMs)
  );
}

export function trajectoryEventAtTime(
  events: readonly TrajectoryEvent[],
  timeMs: number,
): TrajectoryEvent | null {
  const containing = events
    .filter((event) => event.startMs <= timeMs && event.updatedAtMs >= timeMs)
    .sort(
      (left, right) =>
        left.updatedAtMs - left.startMs - (right.updatedAtMs - right.startMs) ||
        left.sequence - right.sequence ||
        left.contentIndex - right.contentIndex ||
        left.id.localeCompare(right.id),
    );
  if (containing[0]) return containing[0];

  const after = events
    .filter((event) => event.startMs > timeMs)
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.sequence - right.sequence ||
        left.contentIndex - right.contentIndex ||
        left.id.localeCompare(right.id),
    );
  if (after[0]) return after[0];

  return (
    [...events]
      .filter((event) => event.startMs <= timeMs)
      .sort(
        (left, right) =>
          right.startMs - left.startMs ||
          right.sequence - left.sequence ||
          right.contentIndex - left.contentIndex ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}

function eventPosition(
  event: TrajectoryEvent,
  turn: TrajectoryTurn,
): { naturalWidth: number; width: number; x: number } {
  const duration = Math.max(1, turn.timelineEndMs - turn.timelineStartMs);
  const plotWidth = SVG_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const x =
    PLOT_LEFT + ((event.startMs - turn.timelineStartMs) / duration) * plotWidth;
  const endX =
    PLOT_LEFT +
    ((event.updatedAtMs - turn.timelineStartMs) / duration) * plotWidth;
  return {
    naturalWidth: Math.max(0, endX - x),
    width: Math.max(event.timingQuality === "instant" ? 2 : 3, endX - x),
    x: clamp(x, PLOT_LEFT, SVG_WIDTH - PLOT_RIGHT),
  };
}

export function trajectoryTimelineMarks(
  events: readonly TrajectoryEvent[],
  turn: TrajectoryTurn,
): TimelineMark[] {
  const marks: TimelineMark[] = [];
  const denseBuckets = new Map<string, TimelineMark>();
  for (const event of events) {
    const position = eventPosition(event, turn);
    if (position.naturalWidth >= 1) {
      marks.push({ count: 1, event, width: position.width, x: position.x });
      continue;
    }
    const bucketKey = `${event.agentKey}:${event.lane}:${Math.floor(position.x)}`;
    const existing = denseBuckets.get(bucketKey);
    if (existing) {
      existing.count += 1;
      existing.width = Math.max(existing.width, position.width);
      continue;
    }
    const mark = { count: 1, event, width: position.width, x: position.x };
    denseBuckets.set(bucketKey, mark);
    marks.push(mark);
  }
  return marks;
}

export function trajectoryKeyboardAction(input: {
  durationMs: number;
  key: string;
  playheadMs: number;
  shiftKey: boolean;
  timelineEndMs: number;
  timelineStartMs: number;
}): { select: boolean; timeMs: number } | null {
  const smallStep = Math.max(1, input.durationMs / 50);
  const largeStep = Math.max(smallStep, input.durationMs / 10);
  if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
    const direction = input.key === "ArrowLeft" ? -1 : 1;
    return {
      select: false,
      timeMs: clamp(
        input.playheadMs + direction * (input.shiftKey ? largeStep : smallStep),
        input.timelineStartMs,
        input.timelineEndMs,
      ),
    };
  }
  if (input.key === "Home" || input.key === "End") {
    return {
      select: false,
      timeMs:
        input.key === "Home" ? input.timelineStartMs : input.timelineEndMs,
    };
  }
  if (input.key === "Enter") {
    return {
      select: true,
      timeMs: clamp(
        input.playheadMs,
        input.timelineStartMs,
        input.timelineEndMs,
      ),
    };
  }
  return null;
}

function accessibleDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} milliseconds`;
  return `${(durationMs / 1_000).toFixed(1)} seconds`;
}

function laneClass(lane: TrajectoryLane): string {
  if (lane === "input") return "fill-sky-500";
  if (lane === "model") return "fill-violet-500";
  if (lane === "changes") return "fill-emerald-500";
  return "fill-amber-500";
}

export function TrajectoryTimeline({
  events,
  onMovePlayhead,
  onSelectEvent,
  playheadMs,
  turn,
  agents = turn.agents,
}: {
  agents?: readonly TrajectoryAgent[];
  events: readonly TrajectoryEvent[];
  onMovePlayhead(timeMs: number): void;
  onSelectEvent(event: TrajectoryEvent, timeMs: number): void;
  playheadMs: number;
  turn: TrajectoryTurn;
}) {
  const duration = Math.max(1, turn.timelineEndMs - turn.timelineStartMs);
  const marks = trajectoryTimelineMarks(events, turn);
  const tracks = agents;
  const svgHeight = Math.max(TRACK_HEIGHT, tracks.length * TRACK_HEIGHT);
  const agentIndex = new Map(tracks.map((agent, index) => [agent.key, index]));
  const selectAtTime = (timeMs: number) => {
    onMovePlayhead(timeMs);
    const event = trajectoryEventAtTime(events, timeMs);
    if (event) onSelectEvent(event, timeMs);
  };
  const seekFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    selectAtTime(
      trajectoryTimeAtClientX({
        clientX: event.clientX,
        left: bounds.left,
        timelineEndMs: turn.timelineEndMs,
        timelineStartMs: turn.timelineStartMs,
        width: bounds.width,
      }),
    );
  };
  const seekFromKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    const action = trajectoryKeyboardAction({
      durationMs: duration,
      key: event.key,
      playheadMs,
      shiftKey: event.shiftKey,
      timelineEndMs: turn.timelineEndMs,
      timelineStartMs: turn.timelineStartMs,
    });
    if (!action) return;
    event.preventDefault();
    if (action.select) selectAtTime(action.timeMs);
    else onMovePlayhead(action.timeMs);
  };

  return (
    <div
      className="overflow-y-auto overscroll-contain"
      data-scrollable={tracks.length > MAX_VISIBLE_TRACKS ? "true" : "false"}
      data-slot="trajectory-track-viewport"
      style={{ maxHeight: TRACK_HEIGHT * MAX_VISIBLE_TRACKS }}
    >
      <div className="flex min-w-0" style={{ height: svgHeight }}>
        <div
          aria-label="Trajectory agents"
          className="relative w-28 shrink-0 border-r bg-background/40"
        >
          {tracks.map((agent, index) => (
            <div
              className="absolute inset-x-0 flex items-center truncate pr-1 text-[10px] text-muted-foreground"
              data-agent-key={agent.key}
              key={agent.key}
              style={{
                height: TRACK_HEIGHT,
                paddingLeft: 6 + Math.min(agent.depth, 5) * 9,
                top: index * TRACK_HEIGHT,
              }}
              title={agent.path.join(" / ")}
            >
              <span className="truncate">{agent.label}</span>
            </div>
          ))}
        </div>
        <svg
          aria-label="Turn trajectory timeline"
          aria-valuemax={turn.timelineEndMs}
          aria-valuemin={turn.timelineStartMs}
          aria-valuenow={Math.round(playheadMs)}
          aria-valuetext={`${accessibleDuration(playheadMs - turn.timelineStartMs)} of ${accessibleDuration(duration)}`}
          className="block min-w-0 flex-1 cursor-crosshair select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={seekFromKeyboard}
          onPointerDown={seekFromPointer}
          preserveAspectRatio="none"
          role="slider"
          style={{ height: svgHeight }}
          tabIndex={0}
          viewBox={`0 0 ${SVG_WIDTH} ${svgHeight}`}
        >
          {tracks.map((agent, index) => {
            const centerY = index * TRACK_HEIGHT + TRACK_HEIGHT / 2;
            return (
              <line
                className="stroke-border"
                key={agent.key}
                strokeWidth="1"
                x1={PLOT_LEFT}
                x2={SVG_WIDTH - PLOT_RIGHT}
                y1={centerY}
                y2={centerY}
              />
            );
          })}
          {marks.map((mark) => {
            const { event } = mark;
            const trackIndex = agentIndex.get(event.agentKey);
            if (trackIndex === undefined) return null;
            const height = event.timingQuality === "instant" ? 18 : 16;
            const label =
              mark.count === 1
                ? `${event.agentLabel}, ${event.label}, ${event.status}, ${event.timingQuality} timing`
                : `${mark.count} ${event.lane === "changes" ? "change" : event.lane} events for ${event.agentLabel} near ${accessibleDuration(event.startMs - turn.timelineStartMs)}`;
            return (
              <rect
                aria-label={label}
                className={cn(
                  laneClass(event.lane),
                  "outline-none focus-visible:stroke-foreground",
                  event.status === "running"
                    ? "opacity-100 motion-safe:animate-pulse"
                    : "opacity-80",
                  (event.status === "failed" || event.status === "declined") &&
                    "stroke-destructive",
                )}
                data-agent-key={event.agentKey}
                data-aggregate-count={mark.count}
                data-event-id={event.id}
                data-timing-quality={event.timingQuality}
                height={height}
                key={`${event.id}:${mark.count}`}
                onFocus={() => onMovePlayhead(event.startMs)}
                onKeyDown={(keyboardEvent) => {
                  if (
                    keyboardEvent.key !== "Enter" &&
                    keyboardEvent.key !== " "
                  ) {
                    return;
                  }
                  keyboardEvent.preventDefault();
                  onMovePlayhead(event.startMs);
                  onSelectEvent(event, event.startMs);
                }}
                onPointerDown={(pointerEvent) => {
                  pointerEvent.stopPropagation();
                  onMovePlayhead(event.startMs);
                  onSelectEvent(event, event.startMs);
                }}
                role="button"
                rx="2"
                strokeDasharray={
                  event.timingQuality === "derived" ? "3 2" : undefined
                }
                strokeWidth={event.timingQuality === "derived" ? 1 : undefined}
                tabIndex={0}
                width={mark.width}
                x={mark.x}
                y={trackIndex * TRACK_HEIGHT + (TRACK_HEIGHT - height) / 2}
              >
                <title>{label}</title>
              </rect>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
