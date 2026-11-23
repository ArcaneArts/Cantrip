import { z } from "zod";

/** Produced by the Worker's actual Docker carrier, never by the guest helper. */
export const cantripOsDockerCarrierSchema = z
  .object({
    kind: z.literal("docker"),
    containerId: z.string().min(1).max(200),
  })
  .strict();

export const cantripOsPowerTargetSchema = cantripOsDockerCarrierSchema
  .extend({
    generation: z.uuid(),
  })
  .strict();

export const cantripOsPowerObservationSchema = z
  .object({
    containerId: z.string().min(1).max(200),
    running: z.boolean(),
    status: z.string().min(1).max(200),
    startedAt: z.string().min(1).max(200),
    finishedAt: z.string().min(1).max(200),
  })
  .strict();

export const cantripOsPowerActionSchema = z.enum(["start", "stop", "restart"]);
export const cantripOsPowerEvidenceSchema = z.enum([
  "acknowledged-and-observed",
  "observed-state",
]);
export type CantripOsPowerTarget = z.infer<typeof cantripOsPowerTargetSchema>;
export type CantripOsPowerObservation = z.infer<
  typeof cantripOsPowerObservationSchema
>;
