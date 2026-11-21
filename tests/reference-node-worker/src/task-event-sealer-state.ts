import { z } from "zod";
import { taskMessageOpaqueContentSchema } from "@cantrip/protocol/tasks";

/** Private continuation data. Store only inside the Task-content protected
 * checkpoint envelope; the cached completion includes its comparison text. */
export const taskEventSealerStateSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["default", "goal", "plan"]),
    ids: z.array(z.tuple([z.string().min(1), z.uuid()])),
    completedRootMessage: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        text: z.string(),
        message: taskMessageOpaqueContentSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.ids.map(([key]) => key),
      ids = value.ids.map(([, id]) => id);
    if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Task event continuation contains duplicate identities.",
      });
    const completed = value.completedRootMessage;
    if (
      completed &&
      (!ids.includes(completed.message.id) ||
        completed.message.classification.role !== "assistant" ||
        completed.message.classification.mode !== value.mode)
    )
      context.addIssue({
        code: "custom",
        path: ["completedRootMessage"],
        message: "Task completion does not belong to its event continuation.",
      });
  });
export type TaskEventSealerState = z.infer<typeof taskEventSealerStateSchema>;
