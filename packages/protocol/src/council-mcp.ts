import { z } from "zod";

import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import {
  encryptedMcpServerCreateSchema,
  mcpServerConfigurationSchema,
  mcpServerNameSchema,
} from "./mcp-configurations.js";

export const councilMcpSetupInputSchema = z
  .object({
    operationId: z.uuid(),
    configuration: mcpServerConfigurationSchema,
  })
  .strict();

export const councilMcpSetupWireSchema = z
  .object({
    operationId: z.uuid(),
    server: encryptedMcpServerCreateSchema,
  })
  .strict();

export const councilMcpSetupToolOutputSchema = cantripMcpReadResultBaseSchema
  .extend({
    mutated: z.literal(true),
    data: z
      .object({
        id: z.uuid(),
        workerId: z.string().min(1).max(255),
        name: mcpServerNameSchema,
        transport: z.enum(["stdio", "http"]),
        enabled: z.boolean(),
      })
      .strict(),
  })
  .strict();
