import { z } from "zod";
import { nativeTurnModelAttributionSchema } from "./native-turn-model-attribution.js";

/** A logical attempt may contain multiple root/child native turns. Observed IDs
 * without a capture remain explicit gaps rather than inheriting launch settings. */
export const nativeBehaviorAttributionSchema = z
  .object({
    version: z.literal(1),
    turnIds: z.array(z.string().min(1)),
    captures: z.array(nativeTurnModelAttributionSchema),
    conflictingTurnKeys: z.array(z.string().min(1)),
  })
  .strict();
export type NativeBehaviorAttribution = z.infer<
  typeof nativeBehaviorAttributionSchema
>;
export const emptyNativeBehaviorAttribution =
  (): NativeBehaviorAttribution => ({
    version: 1,
    turnIds: [],
    captures: [],
    conflictingTurnKeys: [],
  });
export function mergeNativeBehaviorAttribution(
  prior: NativeBehaviorAttribution | null | undefined,
  incoming: NativeBehaviorAttribution,
): NativeBehaviorAttribution {
  const captures = new Map<
    string,
    NativeBehaviorAttribution["captures"][number]
  >();
  const conflicts = new Set<string>();
  const turnIds = new Set<string>();
  for (const raw of [prior, incoming]) {
    if (!raw) continue;
    const evidence = nativeBehaviorAttributionSchema.parse(raw);
    for (const id of evidence.turnIds) turnIds.add(id);
    for (const key of evidence.conflictingTurnKeys) conflicts.add(key);
    for (const capture of evidence.captures) {
      turnIds.add(capture.turnId);
      const key = JSON.stringify([capture.threadId, capture.turnId]);
      const existing = captures.get(key);
      if (!existing) captures.set(key, capture);
      else if (JSON.stringify(existing) !== JSON.stringify(capture))
        conflicts.add(key);
    }
  }
  return {
    version: 1,
    turnIds: [...turnIds].sort(),
    captures: [...captures.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, capture]) => capture),
    conflictingTurnKeys: [...conflicts].sort(),
  };
}
export function summarizeNativeBehaviorAttribution(
  evidence: NativeBehaviorAttribution,
) {
  const captured = new Set(evidence.captures.map((capture) => capture.turnId));
  const covered =
    evidence.turnIds.length > 0 &&
    evidence.turnIds.every((id) => captured.has(id)) &&
    !evidence.conflictingTurnKeys.length;
  const efforts = new Set(
    evidence.captures.map((capture) => capture.reasoningEffort),
  );
  const selections = new Set(
    evidence.captures.map((capture) => JSON.stringify(capture.selection)),
  );
  const selection =
    covered && selections.size === 1
      ? evidence.captures[0]?.selection
      : undefined;
  const reasoningKnown = covered && efforts.size === 1;
  return {
    selection: selection?.status === "resolved" ? selection : undefined,
    reasoningKnown,
    reasoningEffort: reasoningKnown
      ? evidence.captures[0]!.reasoningEffort
      : null,
    turnId:
      evidence.turnIds.length === 1 && evidence.captures.length <= 1
        ? evidence.turnIds[0]!
        : null,
  };
}
