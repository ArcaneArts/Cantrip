import { describe, expect, it } from "vitest";

import {
  groupAgentTime,
  summarizeAgentTime,
  type AgentTimeInterval,
} from "../src/analytics/agent-time.js";

const minute = 60_000;
const origin = new Date("2026-08-23T12:00:00.000Z");

function interval(
  startMinutes: number,
  endMinutes: number | null,
  attemptStatus = endMinutes === null ? "running" : "completed",
): AgentTimeInterval {
  return {
    attemptStatus,
    startedAt: new Date(origin.getTime() + startMinutes * minute),
    completedAt:
      endMinutes === null
        ? null
        : new Date(origin.getTime() + endMinutes * minute),
  };
}

describe("agent time analytics", () => {
  it("separates summed agent time from merged wall-clock time", () => {
    expect(
      summarizeAgentTime(
        [interval(0, 10), interval(0, 10)],
        new Date(origin.getTime() + 20 * minute),
      ),
    ).toEqual({
      activeAgentCount: 0,
      agentTimeMs: 20 * minute,
      wallTimeMs: 10 * minute,
      averageConcurrency: 2,
    });
  });

  it("merges partial overlap and includes live attempts", () => {
    expect(
      summarizeAgentTime(
        [interval(0, 10), interval(5, 15), interval(20, null)],
        new Date(origin.getTime() + 25 * minute),
      ),
    ).toEqual({
      activeAgentCount: 1,
      agentTimeMs: 25 * minute,
      wallTimeMs: 20 * minute,
      averageConcurrency: 1.25,
    });
  });

  it("groups intervals without attributing unknown dimensions", () => {
    const values = [
      { ...interval(0, 5), modelId: "model-a" },
      { ...interval(0, 5), modelId: "model-a" },
      { ...interval(10, 15), modelId: null },
    ];
    expect(
      groupAgentTime(
        values,
        (value) => value.modelId,
        new Date(origin.getTime() + 20 * minute),
      ).get("model-a"),
    ).toEqual({
      activeAgentCount: 0,
      agentTimeMs: 10 * minute,
      wallTimeMs: 5 * minute,
      averageConcurrency: 2,
    });
  });

  it("caps abandoned running attempts without reporting them as active", () => {
    const result = summarizeAgentTime(
      [interval(0, null)],
      new Date(origin.getTime() + 48 * 60 * minute),
    );
    expect(result.activeAgentCount).toBe(0);
    expect(result.agentTimeMs).toBe(24 * 60 * minute);
  });
});
