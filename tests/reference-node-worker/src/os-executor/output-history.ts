/** Output and lifecycle events share native sequence numbers. Only the
 * executor's actual eviction boundary establishes that output was lost. */
export interface NativeOutputHistory {
  outputEvictedThroughSeq?: number | null;
}

export function evictedOutputAfter(
  read: NativeOutputHistory,
  afterSeq: number | null,
): number | null {
  const boundary = read.outputEvictedThroughSeq;
  return boundary != null && boundary > (afterSeq ?? 0) ? boundary : null;
}

export function outputEvictionNotice(boundary: number): string {
  return `\r\n[Earlier Linux command output through native sequence ${boundary} was evicted; the command was not repeated.]\r\n`;
}

export const outputCoverageUnavailableNotice =
  "\r\n[This executor does not report output retention coverage; earlier command history may be unavailable.]\r\n";
