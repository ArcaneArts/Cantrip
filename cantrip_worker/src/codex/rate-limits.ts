import { randomUUID } from "node:crypto";

import {
  providerQuotaSnapshotSchema,
  type ProviderQuotaSnapshot,
  type ProviderWeeklyUsage,
} from "@cantrip/protocol";

export const WEEKLY_RATE_LIMIT_WINDOW_MINUTES = 7 * 24 * 60;

interface RateLimitWindow {
  resetsAt: number | null;
  usedPercent: number;
  windowDurationMins: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface AccountRateLimitsResult {
  rateLimits?: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export interface QuotaSnapshotOptions {
  codexVersion: string | null;
  now?: () => number;
  snapshotId?: string;
  workerVersion: string | null;
}

function finitePercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Preserves every quota bucket returned by Codex while identifying the single
 * canonical seven-day window used by the current account projection.
 */
export function quotaSnapshotFromRateLimits(
  result: AccountRateLimitsResult,
  options: QuotaSnapshotOptions,
): ProviderQuotaSnapshot {
  const canonical =
    result.rateLimits ?? result.rateLimitsByLimitId?.codex ?? null;
  const buckets = new Map<string, RateLimitSnapshot>();
  for (const [limitId, snapshot] of Object.entries(
    result.rateLimitsByLimitId ?? {},
  )) {
    buckets.set(limitId, snapshot);
  }
  if (canonical) {
    const canonicalId = canonical.limitId?.trim() || "codex";
    if (!buckets.has(canonicalId)) buckets.set(canonicalId, canonical);
  }

  const windows: ProviderQuotaSnapshot["windows"] = [];
  for (const [bucketId, snapshot] of buckets) {
    for (const windowKind of ["primary", "secondary"] as const) {
      const window = snapshot[windowKind];
      if (!window || !finitePercent(window.usedPercent)) continue;
      const effectiveLimitId = snapshot.limitId?.trim() || bucketId;
      const canonicalLimitId = canonical?.limitId?.trim() || "codex";
      const isCanonical =
        snapshot === canonical || effectiveLimitId === canonicalLimitId;
      windows.push({
        limitId: effectiveLimitId,
        limitName: snapshot.limitName ?? null,
        planType: snapshot.planType ?? null,
        reachedType: snapshot.rateLimitReachedType ?? null,
        windowKind,
        usedPercent: window.usedPercent,
        windowDurationMinutes: window.windowDurationMins,
        resetsAt: window.resetsAt,
        isWeeklyProjection:
          isCanonical &&
          window.windowDurationMins === WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
        rawPayload: {
          limitId: effectiveLimitId,
          limitName: snapshot.limitName ?? null,
          planType: snapshot.planType ?? null,
          reachedType: snapshot.rateLimitReachedType ?? null,
          windowKind,
          usedPercent: window.usedPercent,
          windowDurationMinutes: window.windowDurationMins,
          resetsAt: window.resetsAt,
        },
      });
    }
  }
  return providerQuotaSnapshotSchema.parse({
    snapshotId: options.snapshotId ?? randomUUID(),
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    workerVersion: options.workerVersion,
    codexVersion: options.codexVersion,
    windows,
  });
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
