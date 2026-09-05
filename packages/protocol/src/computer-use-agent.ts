import { z } from "zod";
import { cantripMcpBindingSchema } from "./cantrip-mcp.js";
import { cuaIdSchema } from "./computer-use.js";
import { cuaPreviewAuthoritySchema } from "./computer-use-preview.js";

/** Worker-authenticated binding claims; never model-supplied tool arguments. */
export const cuaAgentAuthorityRequestSchema = z.strictObject({
  binding: cantripMcpBindingSchema,
});

/** Current durable placement/policy. Native thread/turn lifetime stays worker-owned. */
export const cuaAgentAuthoritySchema = cuaPreviewAuthoritySchema.extend({
  executionLaneId: cuaIdSchema,
});

export type CuaAgentAuthority = z.infer<typeof cuaAgentAuthoritySchema>;
