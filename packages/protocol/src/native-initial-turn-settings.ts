import { z } from "zod";

/** Immutable settings captured by native execution at turn start. Later steps
 * may use different settings; absence is unavailable evidence, not defaults. */
export const nativeInitialTurnSettingsSchema = z
  .object({
    model: z.string(),
    modelProvider: z.string(),
    reasoningEffort: z.string().nullable(),
    effectiveReasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    effectiveServiceTier: z.string().nullable(),
    collaborationMode: z.string(),
  })
  .strict();
export type NativeInitialTurnSettings = z.infer<
  typeof nativeInitialTurnSettingsSchema
>;
