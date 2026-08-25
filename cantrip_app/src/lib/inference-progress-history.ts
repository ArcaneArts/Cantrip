import type { InferenceProgressSnapshot } from "@cantrip/protocol";

export interface InferenceProgressTrace {
  completedAt: string | null;
  progress: InferenceProgressSnapshot;
}

const MAX_INFERENCE_PROGRESS_TRACES = 32;

export function inferenceProgressHistoryQueryKey(chatId: string) {
  return ["inference-progress-history", chatId] as const;
}

function traceKey(progress: InferenceProgressSnapshot): string {
  return `${progress.requestId}:${progress.cycle}`;
}

export function upsertInferenceProgressTrace(
  current: readonly InferenceProgressTrace[] | undefined,
  progress: InferenceProgressSnapshot,
): InferenceProgressTrace[] {
  const key = traceKey(progress);
  const next = (current ?? []).filter(
    (trace) => traceKey(trace.progress) !== key,
  );
  next.push({ completedAt: null, progress });
  return next.slice(-MAX_INFERENCE_PROGRESS_TRACES);
}

export function completeInferenceProgressTrace(
  current: readonly InferenceProgressTrace[] | undefined,
  progress: InferenceProgressSnapshot,
  completedAt: string,
): InferenceProgressTrace[] {
  const key = traceKey(progress);
  const traces = current ?? [];
  if (!traces.some((trace) => traceKey(trace.progress) === key)) {
    return [...traces, { completedAt, progress }].slice(
      -MAX_INFERENCE_PROGRESS_TRACES,
    );
  }
  return traces.map((trace) =>
    traceKey(trace.progress) === key
      ? { completedAt, progress: trace.progress }
      : trace,
  );
}
