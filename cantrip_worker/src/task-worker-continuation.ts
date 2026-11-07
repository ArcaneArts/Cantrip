import { z } from "zod";
import {
  taskOperationRelayRequestSchema,
  taskMessageOpaqueContentSchema,
} from "@cantrip/protocol/tasks";
import { taskEventSealerStateSchema } from "./task-event-sealer-state.js";

/** Original opaque logical round plus its published event identities. This is
 * protected Task continuation content, never permission to submit its prompt. */
const roundContinuationSchema = z
  .object({
    version: z.literal(1),
    request: taskOperationRelayRequestSchema,
    events: taskEventSealerStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const mode =
      value.request.classification.kind === "direct" ? "default" : "plan";
    if (value.events.mode !== mode)
      context.addIssue({
        code: "custom",
        path: ["events", "mode"],
        message: "Task continuation changed its original round mode.",
      });
  });
const goalContinuationSchema = z
  .object({
    version: z.literal(2),
    prompt: taskMessageOpaqueContentSchema,
    publication: z
      .object({ id: z.uuid(), idempotencyKey: z.string().min(1).max(200) })
      .strict(),
    events: taskEventSealerStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.prompt.classification.mode !== "goal" ||
      value.events.mode !== "goal"
    )
      context.addIssue({
        code: "custom",
        path: ["events", "mode"],
        message: "Goal continuation changed its original mode.",
      });
  });
export const taskWorkerContinuationSchema = z.discriminatedUnion("version", [
  roundContinuationSchema,
  goalContinuationSchema,
]);
export type TaskWorkerContinuation = z.infer<
  typeof taskWorkerContinuationSchema
>;
