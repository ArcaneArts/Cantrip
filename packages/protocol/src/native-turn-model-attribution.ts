import { z } from "zod";
import { nativeModelAttributionSchema } from "./native-model-attribution.js";

/** Captured at native turn start, never inferred from later thread settings. */
export const nativeTurnModelAttributionSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    isRoot: z.boolean(),
    reasoningEffort: z.string().nullable(),
    selection: nativeModelAttributionSchema,
  })
  .strict();
export type NativeTurnModelAttribution = z.infer<
  typeof nativeTurnModelAttributionSchema
>;
