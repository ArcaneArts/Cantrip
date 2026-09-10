import { z } from "zod";

export const managedChatPreparationSchema = z.object({
  chatId: z.string().min(1),
  workerId: z.string().min(1),
  terminalId: z.string().uuid(),
  generation: z.string().uuid(),
  phase: z.enum(["pending", "thread", "console", "ready", "failed"]),
  failedPhase: z.enum(["thread", "console"]).nullable(),
  updatedAt: z.string().datetime(),
});
export type ManagedChatPreparation = z.infer<
  typeof managedChatPreparationSchema
>;
