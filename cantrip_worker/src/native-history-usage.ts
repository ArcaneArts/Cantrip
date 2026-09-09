import { nativeHistoryModelAttributionForTurn } from "./native-history-model-attribution.js";
import { z } from "zod";
import {
  nativeResponseUsageCountsSchema,
  reconcileNativeHistoryUsage,
  type NativeHistoryUsage,
} from "@cantrip/protocol";

const sourceSchema = z.object({
  retention: z.enum(["complete", "partial", "unavailable"]),
  cantripModelAttribution: z.unknown().optional(),
  usage: z
    .object({
      responses: z.array(
        z.object({
          threadId: z.string(),
          responseId: z.string().min(1),
          usage: nativeResponseUsageCountsSchema.strip(),
        }),
      ),
      conflictingResponseIds: z.array(z.string()),
    })
    .nullable(),
});

/** Derive only retained response evidence for this physical turn's thread.
 * Thread cumulative / latest-response notifications are not turn totals. */
export function nativeHistoryUsageForTurn(
  threadId: string,
  turnId: string,
  metadata: unknown,
): NativeHistoryUsage | undefined {
  const parsed = sourceSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const source = parsed.data;
  if (!source.usage && source.retention !== "complete") return undefined;
  const capture = nativeHistoryModelAttributionForTurn(
    threadId,
    turnId,
    source,
  );
  const responses = (source.usage?.responses ?? [])
    .filter((response) => response.threadId === threadId)
    .map(({ responseId, usage }) => ({ responseId, usage }));
  // A copied ancestor's responses are not newly executed zero-token work in
  // this thread either: emitting a row would duplicate its elapsed time.
  if (source.usage?.responses.length && !responses.length) return undefined;
  const responseIds = new Set(responses.map((response) => response.responseId));
  return reconcileNativeHistoryUsage(undefined, {
    version: 1,
    ...(capture ? { modelAttribution: capture } : {}),
    responses,
    complete: source.retention === "complete",
    conflictingResponseIds: (source.usage?.conflictingResponseIds ?? []).filter(
      (id) => responseIds.has(id),
    ),
  }).evidence;
}
