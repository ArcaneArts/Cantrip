import { z } from "zod";

/** Canonical source identities only. Guest transport and paths stay on the Worker. */
export const cantripOsTunnelSourceSchema = z.strictObject({
  bindingId: z.uuid(),
  worktreeId: z.string().min(1).max(200),
  bindingGeneration: z.uuid(),
  attachmentGeneration: z.uuid(),
  runtimeGeneration: z.uuid(),
});

export const cantripOsTcpDestinationSchema = z.strictObject({
  kind: z.literal("worker-os-tcp"),
  workerId: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65_535),
  source: cantripOsTunnelSourceSchema,
});

export type CantripOsTunnelSource = z.infer<typeof cantripOsTunnelSourceSchema>;
