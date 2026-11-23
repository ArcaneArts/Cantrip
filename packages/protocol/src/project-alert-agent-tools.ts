import { z } from "zod";
import {
  projectAlertDetailSchema,
  projectAlertProtectedDetailSchema,
} from "./project-alerts.js";

const key = z.string().uuid();
const revision = z.number().int().min(1).max(2_147_483_647);
export const cantripMcpAlertRaiseInputSchema = projectAlertDetailSchema
  .extend({
    key,
    revision,
    kind: z.enum(["blocked", "action-required"]).default("blocked"),
  })
  .strict();
export const cantripMcpAlertResolveInputSchema = z
  .object({ key, revision })
  .strict();
/** Only the worker sends this relay form; scope and source are derived by the server. */
export const agentAlertMutationWireSchema = z
  .object({
    key,
    revision,
    kind: z.enum(["blocked", "action-required"]),
    status: z.enum(["open", "resolved"]),
    protectedDetail: projectAlertProtectedDetailSchema,
  })
  .strict();
export type AgentAlertMutationWire = z.infer<
  typeof agentAlertMutationWireSchema
>;
