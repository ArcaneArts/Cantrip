import type { TrajectoryEvent, TrajectoryTurn } from "./trajectory-model";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  TrajectoryTimeline,
  trajectoryEventAtTime,
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
        clientX: 988,
        left: 0,
        timelineEndMs: 2_000,
        timelineStartMs: 1_000,
        width: 1_000,
      }),
    ).toBe(2_000);
  });

  it("renders all lanes, event spans, and a visible playhead", () => {
    const markup = renderToStaticMarkup(
      <TrajectoryTimeline
        events={[
          { ...event("input", 1_000, 1_000, 1), lane: "input" },
          event("model", 1_200, 1_400, 2),
          { ...event("tools", 1_500, 1_900, 3), lane: "tools" },
        ]}
        onSeek={vi.fn()}
        playheadMs={1_500}
        turn={turn}
      />,
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="Turn trajectory timeline"');
    expect(markup).toContain(">input</text>");
    expect(markup).toContain(">model</text>");
    expect(markup).toContain(">tools</text>");
    expect(markup).toContain('data-slot="trajectory-playhead"');
    expect(markup).toContain('data-event-id="tools"');
  });
});
