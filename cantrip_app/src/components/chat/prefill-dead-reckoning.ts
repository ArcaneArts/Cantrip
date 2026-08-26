import type { InferenceProgressSnapshot } from "@cantrip/protocol";
import { useEffect, useRef, useState } from "react";

const MAX_PREFILL_SAMPLES = 3;
const MAX_DEAD_RECKONED_PERCENT = 99;
const MIN_TICK_INTERVAL_MS = 16;

export interface PrefillProgressSample {
  exactPercent: number;
  receivedAtMs: number;
}

export function prefillPercent(
  progress: InferenceProgressSnapshot,
): number | null {
  if (
    progress.precision === "indeterminate" ||
    progress.fractionComplete === null
  ) {
    return null;
  }
  return Math.min(100, Math.floor(progress.fractionComplete * 100));
}

export function appendPrefillProgressSample(
  current: readonly PrefillProgressSample[],
  sample: PrefillProgressSample,
): PrefillProgressSample[] {
  return [...current, sample].slice(-MAX_PREFILL_SAMPLES);
}

export function prefillTickIntervalMs(
  samples: readonly PrefillProgressSample[],
): number | null {
  if (samples.length < 2) return null;
  let elapsedMs = 0;
  let advancedPercent = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const intervalMs = current.receivedAtMs - previous.receivedAtMs;
    const intervalPercent = current.exactPercent - previous.exactPercent;
    if (intervalMs <= 0 || intervalPercent <= 0) continue;
    elapsedMs += intervalMs;
    advancedPercent += intervalPercent;
  }
  if (elapsedMs <= 0 || advancedPercent <= 0) return null;
  return Math.max(
    MIN_TICK_INTERVAL_MS,
    Math.round(elapsedMs / advancedPercent),
  );
}

export function useDeadReckonedPrefillPercent(
  progress: InferenceProgressSnapshot,
): number | null {
  const authoritativePercent = prefillPercent(progress);
  const exactPercent =
    progress.fractionComplete === null
      ? null
      : Math.min(100, progress.fractionComplete * 100);
  const cycleKey = `${progress.requestId}:${progress.cycle}`;
  const updateKey = `${cycleKey}:${progress.sequence}`;
  const historyRef = useRef<{
    cycleKey: string;
    lastUpdateKey: string | null;
    samples: PrefillProgressSample[];
  }>({ cycleKey, lastUpdateKey: null, samples: [] });
  const [estimate, setEstimate] = useState<{
    percent: number | null;
    updateKey: string;
  }>({ percent: authoritativePercent, updateKey });

  useEffect(() => {
    const history = historyRef.current;
    if (history.cycleKey !== cycleKey) {
      history.cycleKey = cycleKey;
      history.lastUpdateKey = null;
      history.samples = [];
    }

    if (exactPercent === null || authoritativePercent === null) {
      history.lastUpdateKey = updateKey;
      history.samples = [];
      setEstimate({ percent: null, updateKey });
      return;
    }

    if (history.lastUpdateKey !== updateKey) {
      history.lastUpdateKey = updateKey;
      history.samples = appendPrefillProgressSample(history.samples, {
        exactPercent,
        receivedAtMs: Date.now(),
      });
    }
    setEstimate({ percent: authoritativePercent, updateKey });

    const intervalMs = prefillTickIntervalMs(history.samples);
    if (
      intervalMs === null ||
      authoritativePercent >= MAX_DEAD_RECKONED_PERCENT
    ) {
      return;
    }

    let nextPercent = authoritativePercent;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      nextPercent = Math.min(MAX_DEAD_RECKONED_PERCENT, nextPercent + 1);
      setEstimate({ percent: nextPercent, updateKey });
      if (nextPercent < MAX_DEAD_RECKONED_PERCENT) {
        timer = setTimeout(tick, intervalMs);
      }
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [authoritativePercent, cycleKey, exactPercent, updateKey]);

  return estimate.updateKey === updateKey
    ? estimate.percent
    : authoritativePercent;
}
