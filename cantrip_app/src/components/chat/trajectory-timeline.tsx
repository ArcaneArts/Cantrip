import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

import type {
  TrajectoryEvent,
  TrajectoryLane,
  TrajectoryTurn,
} from "./trajectory-model";

const SVG_WIDTH = 1_000;
const SVG_HEIGHT = 96;
const PLOT_LEFT = 72;
const PLOT_RIGHT = 12;
const laneY: Record<TrajectoryLane, number> = {
  input: 18,
  model: 48,
  tools: 78,
};

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
): { width: number; x: number } {
  const duration = Math.max(1, turn.timelineEndMs - turn.timelineStartMs);
  const plotWidth = SVG_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const x =
    PLOT_LEFT + ((event.startMs - turn.timelineStartMs) / duration) * plotWidth;
  const endX =
    PLOT_LEFT +
    ((event.updatedAtMs - turn.timelineStartMs) / duration) * plotWidth;
  return {
    width: Math.max(3, endX - x),
    x: clamp(x, PLOT_LEFT, SVG_WIDTH - PLOT_RIGHT),
  };
}

function laneClass(lane: TrajectoryLane): string {
  if (lane === "input") return "fill-sky-500";
  if (lane === "model") return "fill-violet-500";
  return "fill-amber-500";
}

export function TrajectoryTimeline({
  events,
  onSeek,
  playheadMs,
  turn,
}: {
  events: readonly TrajectoryEvent[];
  onSeek(timeMs: number): void;
  playheadMs: number;
  turn: TrajectoryTurn;
}) {
  const duration = Math.max(1, turn.timelineEndMs - turn.timelineStartMs);
  const plotWidth = SVG_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const playheadX =
    PLOT_LEFT +
    ((clamp(playheadMs, turn.timelineStartMs, turn.timelineEndMs) -
      turn.timelineStartMs) /
      duration) *
      plotWidth;
  const seekFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek(
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
    const step = Math.max(1, duration / 50);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onSeek(playheadMs + (event.key === "ArrowLeft" ? -step : step));
    } else if (event.key === "Home") {
      event.preventDefault();
      onSeek(turn.timelineStartMs);
    } else if (event.key === "End") {
      event.preventDefault();
      onSeek(turn.timelineEndMs);
    }
  };

  return (
    <svg
      aria-label="Turn trajectory timeline"
      aria-valuemax={turn.timelineEndMs}
      aria-valuemin={turn.timelineStartMs}
      aria-valuenow={Math.round(playheadMs)}
      className="h-24 w-full cursor-crosshair select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={seekFromKeyboard}
      onPointerDown={seekFromPointer}
      role="slider"
      tabIndex={0}
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
    >
      {(["input", "model", "tools"] as const).map((lane) => (
        <g key={lane}>
          <text
            className="fill-muted-foreground text-[11px] capitalize"
            dominantBaseline="middle"
            x="8"
            y={laneY[lane]}
          >
            {lane}
          </text>
          <line
            className="stroke-border"
            x1={PLOT_LEFT}
            x2={SVG_WIDTH - PLOT_RIGHT}
            y1={laneY[lane]}
            y2={laneY[lane]}
          />
        </g>
      ))}
      {events.map((event) => {
        const position = eventPosition(event, turn);
        return (
          <rect
            aria-label={event.label}
            className={cn(
              laneClass(event.lane),
              event.status === "running" ? "opacity-100" : "opacity-80",
            )}
            data-event-id={event.id}
            height="10"
            key={event.id}
            rx="2"
            width={position.width}
            x={position.x}
            y={laneY[event.lane] - 5}
          />
        );
      })}
      <line
        className="stroke-foreground"
        data-slot="trajectory-playhead"
        strokeWidth="2"
        x1={playheadX}
        x2={playheadX}
        y1="3"
        y2={SVG_HEIGHT - 3}
      />
    </svg>
  );
}
