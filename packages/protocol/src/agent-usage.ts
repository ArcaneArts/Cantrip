import { z } from "zod";

export const measuredAgentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
  costAvailable: z.boolean().default(false),
});

export type MeasuredAgentUsage = z.infer<typeof measuredAgentUsageSchema>;
