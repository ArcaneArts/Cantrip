import { z } from "zod";
import { chatGoalWireResponseSchema } from "./chat-runtime.js";

/** The protected Chat Goal representation, without the plaintext legacy union. */
const protectedGoal = chatGoalWireResponseSchema.options[0];
export const projectGoalSnapshotSchema = protectedGoal
  .extend({ goal: protectedGoal.shape.goal.unwrap().strict().nullable() })
  .strict();
export const projectGoalObservationSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    generation: z.string().uuid(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    snapshot: projectGoalSnapshotSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.snapshot.goal && value.snapshot.goal.threadId !== value.threadId)
      ctx.addIssue({
        code: "custom",
        path: ["snapshot", "goal", "threadId"],
        message: "Goal observation belongs to a different thread.",
      });
  });
export type ProjectGoalObservation = z.infer<
  typeof projectGoalObservationSchema
>;
export const projectGoalObservationResultSchema = z
  .object({
    accepted: z.boolean(),
    reason: z
      .enum([
        "retired-worker",
        "retired-chat",
        "not-project-agent",
        "unbound-thread",
        "retired-thread",
      ])
      .optional(),
  })
  .strict();
