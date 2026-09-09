import { z } from "zod";
import { nativeHistoryTurnSchema } from "./native-history.js";
const id = z.string().min(1).max(500);
export const nativeHistoryTurnReadIdentitySchema = z
  .object({ threadId: id, turnId: id })
  .strict();
export const nativeHistoryTurnReadRequestSchema = z
  .object({ turns: z.array(nativeHistoryTurnReadIdentitySchema).max(512) })
  .strict();
export const nativeHistoryTurnReadResponseSchema = z
  .object({
    chatId: id,
    // All binding-local candidates are returned; revisions from different
    // bindings cannot be compared to select an immutable settings winner.
    turns: z.array(
      z
        .object({ bindingId: id, workerId: id, turn: nativeHistoryTurnSchema })
        .strict(),
    ),
  })
  .strict();
export type NativeHistoryTurnReadRequest = z.infer<
  typeof nativeHistoryTurnReadRequestSchema
>;
export type NativeHistoryTurnReadResponse = z.infer<
  typeof nativeHistoryTurnReadResponseSchema
>;
