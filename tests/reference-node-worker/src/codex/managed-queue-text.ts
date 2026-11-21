import type { NativeQueueUserInput } from "../managed-queue-input.js";

/** Native queue commands read text elements in order, separated by newlines. */
export function managedQueueText(
  input: readonly NativeQueueUserInput[],
): string {
  return input
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
}

export function managedQueuePlanPrefix(input: readonly NativeQueueUserInput[]) {
  const text = managedQueueText(input);
  const prefix = text.match(/^\/plan(?:\s+|$)/u)?.[0];
  return prefix === undefined
    ? null
    : {
        length: prefix.length,
        hasInput: text.slice(prefix.length).trim().length > 0,
      };
}

/** Strip a joined-text prefix without merging rich input or changing later spans. */
export function stripManagedQueueTextPrefix(
  input: readonly NativeQueueUserInput[],
  prefixLength: number,
): NativeQueueUserInput[] {
  let remaining = prefixLength;
  let seenText = false;
  const result: NativeQueueUserInput[] = [];
  for (const item of structuredClone(input)) {
    if (item.type !== "text") {
      result.push(item);
      continue;
    }
    // Account for the virtual newline used by managedQueueText, not a byte in
    // either element's native text span coordinate space.
    if (seenText && remaining > 0) remaining--;
    seenText = true;
    const count = Math.min(remaining, item.text.length);
    remaining -= count;
    if (count > 0) {
      const removedBytes = Buffer.byteLength(item.text.slice(0, count));
      item.text = item.text.slice(count);
      item.text_elements = item.text_elements?.flatMap((element) =>
        element.byteRange.start < removedBytes
          ? []
          : [
              {
                ...element,
                byteRange: {
                  start: element.byteRange.start - removedBytes,
                  end: element.byteRange.end - removedBytes,
                },
              },
            ],
      );
      if (!item.text.length) continue;
    }
    result.push(item);
  }
  return result;
}
