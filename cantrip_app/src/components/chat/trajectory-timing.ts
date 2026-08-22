export type TrajectoryTimingQuality = "exact" | "derived" | "instant";

export interface TrajectoryTiming {
  endMs: number;
  quality: TrajectoryTimingQuality;
  startMs: number;
}

export interface TrajectoryTimingInput {
  completedAtMs?: number | null;
  durationMs?: number | null;
  firstObservedAtMs?: number | null;
  lastObservedAtMs?: number | null;
  nowMs: number;
  running: boolean;
  startedAtMs?: number | null;
  turnCompletedAtMs?: number | null;
  turnStartedAtMs?: number | null;
  updatedAtMs?: number | null;
}

function validTime(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function validDuration(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function orderedTiming(
  startMs: number,
  endMs: number,
  quality: TrajectoryTimingQuality,
): TrajectoryTiming {
  return { startMs, endMs: Math.max(startMs, endMs), quality };
}

export function resolveTrajectoryTiming(
  input: TrajectoryTimingInput,
): TrajectoryTiming {
  const startedAtMs = validTime(input.startedAtMs);
  const completedAtMs = validTime(input.completedAtMs);
  const updatedAtMs = validTime(input.updatedAtMs);
  const firstObservedAtMs = validTime(input.firstObservedAtMs);
  const lastObservedAtMs = validTime(input.lastObservedAtMs);
  const turnStartedAtMs = validTime(input.turnStartedAtMs);
  const turnCompletedAtMs = validTime(input.turnCompletedAtMs);
  const nowMs = validTime(input.nowMs) ?? 0;
  const durationMs = validDuration(input.durationMs);

  if (startedAtMs !== null && completedAtMs !== null) {
    return orderedTiming(startedAtMs, completedAtMs, "exact");
  }
  if (startedAtMs !== null && input.running) {
    return orderedTiming(startedAtMs, nowMs, "exact");
  }
  if (completedAtMs !== null && durationMs !== null) {
    return orderedTiming(
      Math.max(0, completedAtMs - durationMs),
      completedAtMs,
      "derived",
    );
  }
  if (startedAtMs !== null && durationMs !== null) {
    return orderedTiming(startedAtMs, startedAtMs + durationMs, "derived");
  }

  const observedStartMs = firstObservedAtMs ?? startedAtMs;
  const observedEndMs =
    completedAtMs ??
    lastObservedAtMs ??
    updatedAtMs ??
    (input.running ? nowMs : null);
  if (observedStartMs !== null && observedEndMs !== null) {
    return orderedTiming(observedStartMs, observedEndMs, "derived");
  }
  if (durationMs !== null) {
    const endMs =
      observedEndMs ?? turnCompletedAtMs ?? lastObservedAtMs ?? nowMs;
    return orderedTiming(
      Math.max(turnStartedAtMs ?? 0, endMs - durationMs),
      endMs,
      "derived",
    );
  }

  const instantMs =
    observedStartMs ??
    observedEndMs ??
    turnStartedAtMs ??
    turnCompletedAtMs ??
    nowMs;
  return orderedTiming(instantMs, instantMs, "instant");
}
