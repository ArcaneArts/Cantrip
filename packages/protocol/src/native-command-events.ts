import { z } from "zod";
import { workerEventSchema, type WorkerEvent } from "./worker-events.js";
const allowed = new Set([
  "agent.protected-message",
  "agent.protected-task-message",
  "agent.interaction.requested.protected",
  "agent.interaction.cleared",
  "agent.interaction.expired",
  "agent.plan.protected",
  "computer-use.approval.request",
  "computer-use.approval.terminal",
]);
type NativeEvent = Extract<
  WorkerEvent,
  {
    type:
      | "agent.protected-message"
      | "agent.protected-task-message"
      | "agent.interaction.requested.protected"
      | "agent.interaction.cleared"
      | "agent.interaction.expired"
      | "agent.plan.protected"
      | "computer-use.approval.request"
      | "computer-use.approval.terminal";
  }
>;
export const nativeCommandEventSchema = z
  .object({
    workerId: z.string().min(1).max(255),
    operationId: z.string().min(1).max(255),
    operationGeneration: z.string().min(1).max(255),
    event: workerEventSchema
      .refine(
        (event) => allowed.has(event.type),
        "Only protected native operation events are accepted.",
      )
      .transform((event) => event as NativeEvent),
  })
  .strict();
export type NativeCommandEvent = z.infer<typeof nativeCommandEventSchema>;
