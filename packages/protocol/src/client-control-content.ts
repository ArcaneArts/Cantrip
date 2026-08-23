import { z } from "zod";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";

export const clientNotificationContentSchema = z
  .object({
    level: z.enum(["info", "warning", "error"]),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const clientNotificationOpaqueSchema =
  endpointContentOpaqueSchema.refine(
    ({ domain }) => domain === "client-control-content",
    "Client notifications require client-control-content ciphertext.",
  );

export const protectedClientNotificationSchema = z
  .object({
    operationId: z.string().uuid(),
    protectedContent: clientNotificationOpaqueSchema,
  })
  .strict();

export type ClientNotificationContent = z.infer<
  typeof clientNotificationContentSchema
>;
export type ProtectedClientNotification = z.infer<
  typeof protectedClientNotificationSchema
>;
