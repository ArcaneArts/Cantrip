import { agentActivitySchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { weeklyUsageFromRateLimitActivity } from "../src/models/provider-account-usage.js";

function activity(limitId: string | null, usedPercent: number) {
  const weekly = {
    usedPercent,
    windowDurationMins: 10_080,
    resetsAt: 1_787_000_000,
  };
  return agentActivitySchema.parse({
    type: "rateLimit",
    id: "rate-limit-1",
    status: "completed",
    limitId,
    limitName: null,
    planType: "pro",
    reachedType: null,
    primary: null,
    secondary: weekly,
  });
}

describe("provider account rate-limit persistence", () => {
  it("accepts canonical and legacy unnamed Codex weekly limits", () => {
    expect(weeklyUsageFromRateLimitActivity(activity("codex", 36))).toEqual({
      usedPercent: 36,
      resetsAt: 1_787_000_000,
    });
    expect(
      weeklyUsageFromRateLimitActivity(activity(null, 41))?.usedPercent,
    ).toBe(41);
  });

  it("ignores unrelated weekly limit buckets", () => {
    expect(
      weeklyUsageFromRateLimitActivity(activity("codex_other", 100)),
    ).toBeNull();
  });
});
