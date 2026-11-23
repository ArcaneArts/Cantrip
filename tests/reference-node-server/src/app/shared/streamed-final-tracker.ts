export type StreamedFinalTracker = {
  turnIds: Set<string>;
  texts: Set<string>;
};

export function createStreamedFinalTracker(): StreamedFinalTracker {
  return { turnIds: new Set(), texts: new Set() };
}

export function recordFinal(
  tracker: StreamedFinalTracker,
  turnId: string | null | undefined,
  text: string,
): void {
  tracker.texts.add(text.trim());
  if (turnId) tracker.turnIds.add(turnId);
}

export function hasFinal(
  tracker: StreamedFinalTracker,
  turnId: string | null | undefined,
  text: string,
): boolean {
  if (turnId && tracker.turnIds.has(turnId)) return true;
  const normalizedText = text.trim();
  return normalizedText
    ? tracker.texts.has(normalizedText)
    : tracker.texts.size > 0;
}
