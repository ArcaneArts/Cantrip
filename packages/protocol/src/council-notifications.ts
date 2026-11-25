import { z } from "zod";

import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import {
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
} from "./communication-content.js";

export const councilMessagePostInputSchema = z
  .object({
    operationId: z.uuid(),
    text: z.string().trim().min(1).max(100_000),
    kind: z.enum(["progress", "message"]).default("message"),
    notify: z.boolean(),
  })
  .strict();

export const councilMessagePostWireSchema = councilMessagePostInputSchema
  .pick({ operationId: true, notify: true })
  .extend({ message: chatMessageOpaqueContentSchema })
  .strict();

export const councilMessagePostOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.boolean(),
    data: z
      .object({
        operationId: z.uuid(),
        messageId: z.uuid(),
        notify: z.boolean(),
      })
      .strict(),
  });

export const councilPendingNotificationsSchema = z
  .array(chatMessageOpaqueSummarySchema)
  .max(10);

export const councilNotificationClaimSchema = z
  .object({ claimed: z.boolean() })
  .strict();
