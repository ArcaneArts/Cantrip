import { z } from "zod";

const id = z.string().min(1).max(255);
/** Model selection is not the physical session's route or permission to migrate
 * providers. These public IDs describe a versioned native settings snapshot. */
export const nativeModelAttributionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("resolved"),
      workerId: id,
      providerId: id,
      providerAccountId: id.nullable(),
      modelId: id,
      routeId: id,
    })
    .strict(),
  z
    .object({ status: z.enum(["unavailable", "unmapped", "ambiguous"]) })
    .strict(),
]);
export type NativeModelAttribution = z.infer<
  typeof nativeModelAttributionSchema
>;

/** Independently authenticated metadata: inventory recovery must not alter the
 * fingerprint of unchanged native settings or impersonate a native revision. */
export const authenticatedNativeModelAttributionSchema = z
  .object({
    selection: nativeModelAttributionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
