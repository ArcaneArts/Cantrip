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
    agentDepth: 0,
    agentIsRoot: true,
    agentKey: "root",
    agentLabel: "Root agent",
    completedAtMs: updatedAtMs,
    contentIndex: 0,
    diagnosticId: null,
    focusItemKey: null,
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
  agents: [
    {
      active: false,
      depth: 0,
      key: "root",
      label: "Root agent",
      lastActiveAtMs: 2_000,
      parentThreadId: null,
      path: ["Root agent"],
      root: true,
      status: "completed",
      threadId: "root-thread",
    },
  ],
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
    expect(
      trajectoryTimelineMarks(
        [
          dense[0]!,
          {
            ...dense[1]!,
            agentKey: "child",
            agentLabel: "Child",
            agentIsRoot: false,
          },
        ],
        turn,
      ),
    ).toHaveLength(2);
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
    expect(markup).toContain(
      "Root agent, tools, completed, exact timing</title>",
    );
    expect(markup).toContain("fill-sky-500");
    expect(markup).toContain("fill-violet-500");
    expect(markup).toContain("fill-amber-500");
    expect(markup).toContain('data-scrollable="false"');
  });

  it("indents agent tracks and scrolls after five rows", () => {
    const agents = Array.from({ length: 6 }, (_, index) => ({
      active: index < 3,
      depth: index === 0 ? 0 : Math.min(index, 3),
      key: index === 0 ? "root" : `child-${index}`,
      label: index === 0 ? "Root agent" : `Child ${index}`,
      lastActiveAtMs: 2_000 - index,
      parentThreadId: index === 0 ? null : "root-thread",
      path: index === 0 ? ["root"] : ["root", `Child ${index}`],
      root: index === 0,
      status: index < 3 ? ("running" as const) : ("completed" as const),
      threadId: index === 0 ? "root-thread" : `child-${index}`,
    }));
    const markup = renderToStaticMarkup(
      <TrajectoryTimeline
        agents={agents}
        events={[]}
        onMovePlayhead={vi.fn()}
        onSelectEvent={vi.fn()}
        playheadMs={1_500}
        turn={{ ...turn, agents }}
      />,
    );
    expect(markup).toContain('data-scrollable="true"');
    expect(markup).toContain('data-slot="trajectory-track-viewport"');
    expect(markup).toContain("Root agent</span>");
    expect(markup).toContain("Child 5</span>");
    expect(markup.match(/data-agent-key=/g)).toHaveLength(6);
    const fiveTrackMarkup = renderToStaticMarkup(
      <TrajectoryTimeline
        agents={agents.slice(0, 5)}
        events={[]}
        onMovePlayhead={vi.fn()}
        onSelectEvent={vi.fn()}
        playheadMs={1_500}
        turn={{ ...turn, agents: agents.slice(0, 5) }}
      />,
    );
    expect(fiveTrackMarkup).toContain('data-scrollable="false"');
  });
});
