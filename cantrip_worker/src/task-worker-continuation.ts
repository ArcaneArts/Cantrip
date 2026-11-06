import { z } from "zod";
import { taskOperationRelayRequestSchema } from "@cantrip/protocol/tasks";
import { taskEventSealerStateSchema } from "./task-event-sealer-state.js";

/** Original opaque logical round plus its published event identities. This is
 * protected Task continuation content, never permission to submit its prompt. */
export const taskWorkerContinuationSchema = z
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
export type TaskWorkerContinuation = z.infer<
  typeof taskWorkerContinuationSchema
>;
