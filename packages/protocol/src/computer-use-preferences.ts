import { z } from "zod";
import { endpointContentOpaqueSchema } from "./endpoint-content.js";

/** Account settings contain ciphertext only; native identities/coordinates are
 * never part of the saved appearance payload. */
export const cuaCursorPreferenceRecordSchema = z.strictObject({
  operationId: z.string().uuid(),
  protectedContent: endpointContentOpaqueSchema.refine(
    (value) =>
      value.domain === "customization-content" &&
      value.envelope.ciphertext.length <= 4 * Math.ceil((4096 + 16) / 3),
    "Cursor preferences require bounded customization ciphertext.",
  ),
});

export function cuaCursorPreferenceContext(operationId: string) {
  return {
    domain: "customization-content" as const,
    workerId: null,
    scopeId: "user-settings:computer-use-cursor",
    operationId,
    operation: "computer-use.cursor-preference",
    direction: "stored" as const,
    sequence: 1,
  };
}

export type CuaCursorPreferenceRecord = z.infer<
  typeof cuaCursorPreferenceRecordSchema
>;
