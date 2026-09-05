import { z } from "zod";
import { computerUseRequestSchema, cuaIdSchema } from "./computer-use.js";

/** Server-routed chat authority; never accepts a client-selected target worker. */
export const workerComputerUseCommandSchema = z.strictObject({
  type: z.literal("computer-use.operation"),
  serverId: cuaIdSchema,
  chatId: cuaIdSchema,
  executionLaneId: cuaIdSchema.nullable(),
  request: computerUseRequestSchema,
});
export type WorkerComputerUseCommand = z.infer<
  typeof workerComputerUseCommandSchema
>;
