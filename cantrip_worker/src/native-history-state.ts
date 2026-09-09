import { z } from "zod";
import { nativeHistoryCursorSchema } from "./codex/native-history.js";
const jsonObject = z.record(z.string(), z.json());
const ordinal = z.number().int().nonnegative();
export const historyOriginSchema = z
  .object({
    generation: z.string().min(1),
    sequence: ordinal,
    kind: z.enum(["snapshot", "notification"]),
    nativeCursor: nativeHistoryCursorSchema.optional(),
  })
  .strict();
const candidateSchema = z
  .object({
    body: jsonObject,
    lifecycle: z.enum(["started", "completed", "unknown"]),
    completeBody: z.boolean(),
    startedAtMs: z.number().nullable(),
    completedAtMs: z.number().nullable(),
    origin: historyOriginSchema,
  })
  .strict();
export const nativeHistoryStateItemSchema = candidateSchema
  .extend({
    id: z.string().min(1),
    identityKind: z.enum(["canonical", "legacy"]),
    revision: ordinal.positive(),
    ordinal,
    conflicts: z.array(candidateSchema),
  })
  .strict();
export const nativeHistoryStateTurnSchema = z
  .object({
    id: z.string().min(1),
    ordinal,
    revision: ordinal.positive(),
    body: jsonObject,
    metadata: jsonObject.nullable(),
    origin: historyOriginSchema,
    items: z.array(nativeHistoryStateItemSchema),
    conflicts: z.array(jsonObject),
  })
  .strict();
export const nativeHistoryStateSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string().min(1),
    turns: z.array(nativeHistoryStateTurnSchema),
    // Raw scoped evidence not yet represented by an item (usage, warnings, settings,
    // unknown methods, malformed payloads). Encrypt as part of projection state.
    evidence: z.array(
      z
        .object({
          recordId: z.string().uuid(),
          method: z.string(),
          params: jsonObject,
        })
        .strict(),
    ),
    notifications: z.array(
      z.object({ generation: z.string(), sequence: ordinal }).strict(),
    ),
  })
  .strict();
export type NativeHistoryState = z.infer<typeof nativeHistoryStateSchema>;
export type NativeHistoryStateTurn = NativeHistoryState["turns"][number];
export type NativeHistoryStateItem = NativeHistoryStateTurn["items"][number];
export type NativeHistoryCandidate = z.infer<typeof candidateSchema>;
export type NativeHistoryOrigin = z.infer<typeof historyOriginSchema>;
export type NativeHistoryObject = z.infer<typeof jsonObject>;
