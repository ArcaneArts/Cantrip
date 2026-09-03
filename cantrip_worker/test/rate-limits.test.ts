import { describe, expect, it } from "vitest";

import {
  quotaSnapshotFromRateLimits,
  weeklyUsageFromRateLimits,
} from "../src/codex/rate-limits.js";

const weekly = (usedPercent: number) => ({
  usedPercent,
  windowDurationMins: 10_080,
  resetsAt: 1_787_000_000,
});

describe("Codex weekly rate limits", () => {
  it("prefers the canonical snapshot over unordered additional limits", () => {
    expect(
      weeklyUsageFromRateLimits({
        rateLimits: { primary: null, secondary: weekly(37) },
        rateLimitsByLimitId: {
          another_limit: { primary: weekly(100), secondary: null },
          codex: { primary: null, secondary: weekly(37) },
        },
      }),
    ).toEqual({ usedPercent: 37, resetsAt: 1_787_000_000 });
  });

  it("falls back to the named canonical snapshot and rejects invalid values", () => {
    expect(
      weeklyUsageFromRateLimits({
        rateLimitsByLimitId: {
          codex: { primary: weekly(42), secondary: null },
        },
      })?.usedPercent,
    ).toBe(42);
    expect(
      weeklyUsageFromRateLimits({
        rateLimits: { primary: weekly(101), secondary: null },
      }),
    ).toBeNull();
  });

  it("preserves every returned bucket and marks only the canonical weekly projection", () => {
    const snapshot = quotaSnapshotFromRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          planType: "pro",
          primary: {
            usedPercent: 8,
            windowDurationMins: 300,
            resetsAt: 1_786_000_000,
          },
          secondary: weekly(37),
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            primary: {
              usedPercent: 8,
              windowDurationMins: 300,
              resetsAt: 1_786_000_000,
            },
            secondary: weekly(37),
          },
          reviews: {
            limitId: "reviews",
            limitName: "Reviews",
            planType: "pro",
            primary: weekly(61),
            secondary: null,
          },
        },
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: "reset-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_786_000_000,
              expiresAt: 1_789_000_000,
              title: "Usage reset",
              description: null,
            },
          ],
        },
      },
      {
        snapshotId: "snapshot-1",
        now: () => Date.parse("2026-08-16T12:00:00.000Z"),
        workerVersion: "1.2.3",
        codexVersion: "0.153.0",
      },
    );

    expect(snapshot).toMatchObject({
      snapshotId: "snapshot-1",
      observedAt: "2026-08-16T12:00:00.000Z",
      workerVersion: "1.2.3",
      codexVersion: "0.153.0",
    });
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.rateLimitResetCredits).toMatchObject({
      availableCount: 1,
      credits: [{ id: "reset-1", status: "available" }],
    });
    expect(
      snapshot.windows.map((window) => [
        window.limitId,
        window.windowKind,
        window.windowDurationMinutes,
        window.isWeeklyProjection,
      ]),
    ).toEqual([
      ["codex", "primary", 300, false],
      ["codex", "secondary", 10_080, true],
      ["reviews", "primary", 10_080, false],
    ]);
  });
});
