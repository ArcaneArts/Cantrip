import { z } from "zod";
import { workerResponseEnvelopeSchema } from "./worker-transport.js";
import {
  workerEventEnvelopeSchema,
  workerNotificationSchema,
} from "./worker-events.js";

export const workerNotificationEnvelopeSchema = z.object({
  kind: z.literal("notification"),
  notification: workerNotificationSchema,
});

export const workerServerEnvelopeSchema = z.union([
  workerResponseEnvelopeSchema,
  workerEventEnvelopeSchema,
  workerNotificationEnvelopeSchema,
]);

export type WorkerNotificationEnvelope = z.infer<
  typeof workerNotificationEnvelopeSchema
>;
export type WorkerServerEnvelope = z.infer<typeof workerServerEnvelopeSchema>;
