import { z } from "zod";

/** Actual canonical resource authorization for an already-issued worker helper.
 * This grants no inference capacity and stores no duplicate prompt or UUID history. */
export const nativeInferenceResourceAuthorizationSchema = z
  .object({
    serverId: z.string().min(1).max(2_000),
    ownerId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
    workerGeneration: z.string().min(1).max(200),
    target: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("chat"), chatId: z.string().min(1).max(200) })
        .strict(),
      z
        .object({
          kind: z.literal("project"),
          projectId: z.string().min(1).max(200),
        })
        .strict(),
    ]),
  })
  .strict();
export const nativeInferenceResourceAuthorizationResultSchema =
  nativeInferenceResourceAuthorizationSchema.extend({
    authorized: z.literal(true),
  });
export type NativeInferenceResourceAuthorization = z.infer<
  typeof nativeInferenceResourceAuthorizationSchema
>;
