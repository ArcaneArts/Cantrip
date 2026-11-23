import { nativeTurnModelAttributionSchema } from "@cantrip/protocol";

/** Only immutable turn-start evidence, never mutable thread/default settings. */
export function nativeHistoryModelAttributionForTurn(
  threadId: string,
  turnId: string,
  metadata: unknown,
) {
  const raw =
    metadata &&
    typeof metadata === "object" &&
    "cantripModelAttribution" in metadata
      ? metadata.cantripModelAttribution
      : undefined;
  const capture = nativeTurnModelAttributionSchema.safeParse(raw);
  return capture.success &&
    capture.data.threadId === threadId &&
    capture.data.turnId === turnId
    ? capture.data
    : undefined;
}
