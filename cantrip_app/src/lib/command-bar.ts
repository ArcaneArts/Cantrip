export const DOUBLE_SHIFT_WINDOW_MS = 1_000;

export type DoubleShiftKeyInput = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
};

export type DoubleShiftKeyResult = {
  lastShiftAt: number | null;
  triggered: boolean;
};

/**
 * Advances the app command-bar gesture. Any intervening key cancels the
 * sequence, so ordinary capitalization does not count as a double Shift.
 */
export function advanceDoubleShiftGesture(
  lastShiftAt: number | null,
  input: DoubleShiftKeyInput,
  now: number,
): DoubleShiftKeyResult {
  if (
    input.key !== "Shift" ||
    input.repeat ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey
  ) {
    return { lastShiftAt: null, triggered: false };
  }
  const triggered =
    lastShiftAt !== null &&
    now >= lastShiftAt &&
    now - lastShiftAt <= DOUBLE_SHIFT_WINDOW_MS;
  return {
    lastShiftAt: triggered ? null : now,
    triggered,
  };
}
