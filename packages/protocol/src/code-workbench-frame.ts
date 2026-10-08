import { z } from "zod";

export const CODE_WORKBENCH_FRAME_NONCE_PARAMETER = "cantripFrameNonce";
export const codeWorkbenchFrameNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/u);

export const codeWorkbenchFrameFailureMessageSchema = z
  .object({
    type: z.literal("cantrip-code.frame-load-failed"),
    version: z.literal(1),
    nonce: codeWorkbenchFrameNonceSchema,
    statusCode: z.number().int().min(400).max(599),
  })
  .strict();
