import { z } from "zod";
import { nativeTurnModelAttributionSchema } from "./native-turn-model-attribution.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeResponseUsageCountsSchema = z
  .object({
    totalTokens: count,
    inputTokens: count,
    cachedInputTokens: count,
    cacheWriteInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count,
  })
  .strict();

/** Public analytics evidence only. Native prompts, tool payloads, provider
 * secrets and raw response bodies remain inside the encrypted turn metadata. */
export const nativeHistoryUsageSchema = z
  .object({
    version: z.literal(1),
    modelAttribution: nativeTurnModelAttributionSchema.optional(),
    responses: z.array(
      z
        .object({
          responseId: z.string().min(1),
          usage: nativeResponseUsageCountsSchema,
        })
        .strict(),
    ),
    complete: z.boolean(),
    conflictingResponseIds: z.array(z.string().min(1)),
  })
  .strict();
export type NativeHistoryUsage = z.infer<typeof nativeHistoryUsageSchema>;

/** Observations accumulate by response identity, never by arrival order or by
 * taking the maximum of unrelated token counters. Keep conflicts explicit and
 * omit their disputed contribution from the known subtotal. */
export function reconcileNativeHistoryUsage(
  previous: NativeHistoryUsage | undefined,
  incoming: NativeHistoryUsage,
) {
  const responses = new Map<string, NativeHistoryUsage["responses"][number]>();
  const conflicts = new Set([
    ...(previous?.conflictingResponseIds ?? []),
    ...incoming.conflictingResponseIds,
  ]);
  for (const response of [
    ...(previous?.responses ?? []),
    ...incoming.responses,
  ]) {
    const retained = responses.get(response.responseId);
    if (
      retained &&
      Object.keys(response.usage).some(
        (key) =>
          response.usage[key as keyof typeof response.usage] !==
          retained.usage[key as keyof typeof response.usage],
      )
    ) {
      conflicts.add(response.responseId);
    } else if (!retained) responses.set(response.responseId, response);
  }
  const ordered = [...responses.values()].sort((a, b) =>
    a.responseId.localeCompare(b.responseId),
  );
  const completeSet = (value: NativeHistoryUsage | undefined) => {
    if (!value?.complete) return false;
    const ids = new Set(value.responses.map((entry) => entry.responseId));
    return ordered.every((response) => ids.has(response.responseId));
  };
  const retainedCapture = previous?.modelAttribution;
  const incomingCapture = incoming.modelAttribution;
  if (
    retainedCapture &&
    incomingCapture &&
    JSON.stringify(nativeTurnModelAttributionSchema.parse(retainedCapture)) !==
      JSON.stringify(nativeTurnModelAttributionSchema.parse(incomingCapture))
  )
    throw new Error(
      "Native usage model attribution conflicts with retained evidence.",
    );
  const evidence: NativeHistoryUsage = {
    version: 1,
    ...((retainedCapture ?? incomingCapture)
      ? { modelAttribution: retainedCapture ?? incomingCapture }
      : {}),
    responses: ordered,
    conflictingResponseIds: [...conflicts].sort(),
    complete:
      conflicts.size === 0 &&
      Boolean(completeSet(previous) || completeSet(incoming)),
  };
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const response of ordered) {
    if (conflicts.has(response.responseId)) continue;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += response.usage[key];
      if (!Number.isSafeInteger(totals[key]))
        return { evidence: { ...evidence, complete: false }, totals: null };
    }
  }
  return { evidence, totals };
}
