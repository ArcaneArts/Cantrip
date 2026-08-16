import type { ProviderWeeklyUsage } from "@cantrip/protocol";

export const WEEKLY_RATE_LIMIT_WINDOW_MINUTES = 7 * 24 * 60;

interface RateLimitWindow {
  resetsAt: number | null;
  usedPercent: number;
  windowDurationMins: number | null;
}

interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface AccountRateLimitsResult {
  rateLimits?: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

/** Selects only Codex's canonical account quota instead of unordered buckets. */
export function weeklyUsageFromRateLimits(
  result: AccountRateLimitsResult,
): ProviderWeeklyUsage | null {
  const canonical =
    result.rateLimits ?? result.rateLimitsByLimitId?.codex ?? null;
  const weekly = canonical
    ? [canonical.primary, canonical.secondary].find(
        (window) =>
          window?.windowDurationMins === WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
      )
    : null;
  if (
    !weekly ||
    !Number.isFinite(weekly.usedPercent) ||
    weekly.usedPercent < 0 ||
    weekly.usedPercent > 100
  ) {
    return null;
  }
  return {
    resetsAt: weekly.resetsAt,
    usedPercent: weekly.usedPercent,
  };
}
