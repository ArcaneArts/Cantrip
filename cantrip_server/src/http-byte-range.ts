export interface HttpByteRange {
  end: number;
  start: number;
}

export type HttpByteRangeResult =
  { kind: "none" } | { kind: "invalid" } | ({ kind: "range" } & HttpByteRange);

function safeByteOffset(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseHttpByteRange(
  header: string | undefined,
  size: number,
): HttpByteRangeResult {
  if (header === undefined) return { kind: "none" };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "invalid" };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return { kind: "invalid" };
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText) {
    const suffixLength = safeByteOffset(endText);
    if (suffixLength === null || suffixLength === 0) return { kind: "invalid" };
    return {
      kind: "range",
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }
  const start = safeByteOffset(startText);
  const requestedEnd = endText ? safeByteOffset(endText) : size - 1;
  if (
    start === null ||
    requestedEnd === null ||
    start >= size ||
    requestedEnd < start
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "range",
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
