import type { AgentTimeSummary } from "@cantrip/protocol";

const MAX_OPEN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface AgentTimeInterval {
  attemptStatus: string;
  completedAt: Date | null;
  startedAt: Date;
}

interface NormalizedInterval {
  active: boolean;
  endMs: number;
  startMs: number;
}

function normalizedInterval(
  interval: AgentTimeInterval,
  nowMs: number,
): NormalizedInterval | null {
  const startMs = interval.startedAt.getTime();
  if (!Number.isFinite(startMs) || startMs > nowMs) return null;
  const open =
    interval.attemptStatus === "running" && interval.completedAt === null;
  const active = open && nowMs - startMs <= MAX_OPEN_INTERVAL_MS;
  const completedAtMs = interval.completedAt?.getTime() ?? null;
  const endMs = open
    ? Math.min(nowMs, startMs + MAX_OPEN_INTERVAL_MS)
    : completedAtMs;
  if (endMs === null || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return { active, endMs, startMs };
}

/**
 * Agent time sums every model execution independently. Wall time merges
 * overlapping executions so two agents working for ten minutes produce
 * twenty agent-minutes, ten wall-minutes, and 2x average concurrency.
 *
 * Open intervals are capped at one day so an interrupted server cannot leave
 * a stale row accumulating time forever.
 */
export function summarizeAgentTime(
  intervals: readonly AgentTimeInterval[],
  now = new Date(),
): AgentTimeSummary {
  const nowMs = now.getTime();
  const normalized = intervals
    .map((interval) => normalizedInterval(interval, nowMs))
    .filter((interval): interval is NormalizedInterval => interval !== null)
    .sort(
      (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
    );
  let activeAgentCount = 0;
  let agentTimeMs = 0;
  let wallTimeMs = 0;
  let mergedStartMs: number | null = null;
  let mergedEndMs: number | null = null;
  for (const interval of normalized) {
    if (interval.active) activeAgentCount += 1;
    agentTimeMs += interval.endMs - interval.startMs;
    if (mergedStartMs === null || mergedEndMs === null) {
      mergedStartMs = interval.startMs;
      mergedEndMs = interval.endMs;
      continue;
    }
    if (interval.startMs <= mergedEndMs) {
      mergedEndMs = Math.max(mergedEndMs, interval.endMs);
      continue;
    }
    wallTimeMs += mergedEndMs - mergedStartMs;
    mergedStartMs = interval.startMs;
    mergedEndMs = interval.endMs;
  }
  if (mergedStartMs !== null && mergedEndMs !== null) {
    wallTimeMs += mergedEndMs - mergedStartMs;
  }
  return {
    activeAgentCount,
    agentTimeMs: Math.round(agentTimeMs),
    wallTimeMs: Math.round(wallTimeMs),
    averageConcurrency:
      wallTimeMs > 0 ? Math.round((agentTimeMs / wallTimeMs) * 100) / 100 : 0,
  };
}

export function groupAgentTime<T extends AgentTimeInterval>(
  intervals: readonly T[],
  key: (interval: T) => string | null,
  now = new Date(),
): Map<string, AgentTimeSummary> {
  const groups = new Map<string, T[]>();
  for (const interval of intervals) {
    const groupKey = key(interval);
    if (!groupKey) continue;
    const group = groups.get(groupKey);
    if (group) group.push(interval);
    else groups.set(groupKey, [interval]);
  }
  return new Map(
    [...groups].map(([groupKey, group]) => [
      groupKey,
      summarizeAgentTime(group, now),
    ]),
  );
}
