import { describe, expect, it } from "vitest";

import { resolveTrajectoryTiming } from "./trajectory-timing";

describe("trajectory timing", () => {
  it("keeps complete runtime timestamps exact", () => {
    expect(
      resolveTrajectoryTiming({
        completedAtMs: 1_300,
        nowMs: 2_000,
        running: false,
        startedAtMs: 1_000,
      }),
    ).toEqual({ startMs: 1_000, endMs: 1_300, quality: "exact" });
  });

  it("extends an exactly started running event to the shared clock", () => {
    expect(
      resolveTrajectoryTiming({
        completedAtMs: null,
        nowMs: 1_450,
        running: true,
        startedAtMs: 1_000,
      }),
    ).toEqual({ startMs: 1_000, endMs: 1_450, quality: "exact" });
  });

  it("derives spans from duration or lifecycle observations", () => {
    expect(
      resolveTrajectoryTiming({
        completedAtMs: 2_000,
        durationMs: 250,
        nowMs: 2_000,
        running: false,
      }),
    ).toEqual({ startMs: 1_750, endMs: 2_000, quality: "derived" });
    expect(
      resolveTrajectoryTiming({
        firstObservedAtMs: 3_000,
        lastObservedAtMs: 3_400,
        nowMs: 4_000,
        running: false,
      }),
    ).toEqual({ startMs: 3_000, endMs: 3_400, quality: "derived" });
  });

  it("uses an honest instant marker for sparse legacy events", () => {
    expect(
      resolveTrajectoryTiming({
        firstObservedAtMs: 5_000,
        nowMs: 6_000,
        running: false,
        turnStartedAtMs: 4_500,
      }),
    ).toEqual({ startMs: 5_000, endMs: 5_000, quality: "instant" });
  });
});
