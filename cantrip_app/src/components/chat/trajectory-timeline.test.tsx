import type { TrajectoryEvent, TrajectoryTurn } from "./trajectory-model";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  TrajectoryTimeline,
  trajectoryEventAtTime,
  trajectoryKeyboardAction,
  trajectoryTimelineMarks,
  trajectoryTimeAtClientX,
} from "./trajectory-timeline";

function event(
  id: string,
  startMs: number,
  updatedAtMs: number,
  sequence: number,
): TrajectoryEvent {
  return {
    activity: null,
    completedAtMs: updatedAtMs,
    contentIndex: 0,
    diagnosticId: null,
    id,
    itemId: null,
    kind: "response",
    label: id,
    lane: "model",
    messageId: `message-${id}`,
    preview: null,
    searchableText: id,
    sequence,
    startMs,
    status: "completed",
    threadId: null,
    timingQuality: "exact",
    turnId: null,
    updatedAtMs,
  };
}

const turn: TrajectoryTurn = {
  completed: true,
  completedAtMs: 2_000,
  elapsedMs: 1_000,
  events: [],
  exactTimingComplete: true,
  key: "legacy:user-1",
  kindCounts: {},
  laneCounts: { input: 0, model: 0, tools: 0 },
  nextTransitionAtMs: null,
  ordinal: 1,
  runtimeTurnId: null,
  startedAtMs: 1_000,
  statusCounts: { running: 0, completed: 0, failed: 0, declined: 0 },
  timelineEndMs: 2_000,
  timelineStartMs: 1_000,
  title: "Turn",
};

describe("trajectory timeline navigation", () => {
  it("prefers the smallest containing interval, then after, then before", () => {
    const events = [
      event("wide", 1_000, 1_800, 1),
      event("narrow", 1_200, 1_400, 2),
      event("later", 1_900, 1_950, 3),
    ];
    expect(trajectoryEventAtTime(events, 1_300)?.id).toBe("narrow");
    expect(trajectoryEventAtTime(events, 1_850)?.id).toBe("later");
    expect(trajectoryEventAtTime(events, 2_000)?.id).toBe("later");
    expect(trajectoryEventAtTime([], 1_300)).toBeNull();
  });

  it("maps pointer positions into clamped timeline time", () => {
    expect(
      trajectoryTimeAtClientX({
        clientX: 0,
        left: 0,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
        width: 1_000,
      }),
    ).toBe(1_000);
    expect(
      trajectoryTimeAtClientX({
        clientX: 1_000,
        left: 0,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
        width: 1_000,
      }),
    ).toBe(2_000);
  });

  it("supports small and shifted keyboard steps plus explicit selection", () => {
    expect(
      trajectoryKeyboardAction({
        durationMs: 1_000,
        key: "ArrowRight",
        playheadMs: 1_000,
        shiftKey: false,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
      }),
    ).toEqual({ select: false, timeMs: 1_020 });
    expect(
      trajectoryKeyboardAction({
        durationMs: 1_000,
        key: "ArrowRight",
        playheadMs: 1_000,
        shiftKey: true,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
      }),
    ).toEqual({ select: false, timeMs: 1_100 });
    expect(
      trajectoryKeyboardAction({
        durationMs: 1_000,
        key: "Enter",
        playheadMs: 1_500,
        shiftKey: false,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
      }),
    ).toEqual({ select: true, timeMs: 1_500 });
  });

  it("aggregates dense sub-pixel events by lane and position", () => {
    const dense = Array.from({ length: 4 }, (_, index) =>
      event(`dense-${index}`, 1_100, 1_100, index),
    );
    expect(trajectoryTimelineMarks(dense, turn)).toHaveLength(1);
    expect(trajectoryTimelineMarks(dense, turn)[0]?.count).toBe(4);
  });

  it("renders full-bleed event bars with hover details", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryTimeline
        events={[
          { ...event("input", 1_000, 1_000, 1), lane: "input" },
          event("model", 1_200, 1_400, 2),
          { ...event("tools", 1_500, 1_900, 3), lane: "tools" },
        ]}
        onMovePlayhead={vi.fn()}
        onSelectEvent={vi.fn()}
        playheadMs={1_500}
        turn={turn}
      />,
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="Turn trajectory timeline"');
    expect(markup).toContain("milliseconds of 1.0 seconds");
    expect(markup).toContain('preserveAspectRatio="none"');
    expect(markup).not.toContain(">input</text>");
    expect(markup).not.toContain(">model</text>");
    expect(markup).not.toContain(">tools</text>");
    expect(markup).not.toContain('data-slot="trajectory-playhead"');
    expect(markup).toContain('data-event-id="tools"');
    expect(markup).toContain('data-timing-quality="exact"');
    expect(markup).toContain("tools, completed, exact timing</title>");
  });
});
