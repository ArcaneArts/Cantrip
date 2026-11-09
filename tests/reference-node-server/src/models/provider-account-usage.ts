import type { AgentActivity, ProviderWeeklyUsage } from "@cantrip/protocol";

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

type RateLimitActivity = Extract<AgentActivity, { type: "rateLimit" }>;

/** Ignores secondary Codex limit buckets that can report their own week. */
export function weeklyUsageFromRateLimitActivity(
  activity: RateLimitActivity,
): ProviderWeeklyUsage | null {
  if (activity.limitId !== null && activity.limitId !== "codex") return null;
  const weekly = [activity.primary, activity.secondary].find(
    (window) => window?.windowDurationMins === WEEKLY_WINDOW_MINUTES,
  );
  return weekly
    ? { resetsAt: weekly.resetsAt, usedPercent: weekly.usedPercent }
    : null;
}
