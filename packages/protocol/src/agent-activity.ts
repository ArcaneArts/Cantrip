import { z } from "zod";

export const chatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const agentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export const workerObservationEventIdentitySchema = z
  .object({
    operationId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200).nullable(),
    messageId: z.string().min(1).max(200).nullable(),
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();
export const agentActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
]);
export const agentCommandOutputLimitBytes = 256 * 1_024;
export const agentFilePreviewLimitCharacters = 8_192;
export const agentActivityRawRequestLimitBytes = 64 * 1_024;
export const agentActivityRawResponseLimitBytes = 256 * 1_024;

function encodedTextLimitSchema(limit: number) {
  return z.string().superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength <= limit) return;
    context.addIssue({
      code: "custom",
      message: `Raw capture text may contain at most ${limit} encoded bytes.`,
    });
  });
}

const agentActivityRawDocumentBaseShape = {
  mediaType: z.string().min(1).max(200),
  originalBytes: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  digest: z.string().min(1).max(200).nullable().optional(),
  omittedReason: z.string().min(1).max(500).nullable().optional(),
};

export const agentActivityRawRequestDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawRequestLimitBytes).nullable(),
});

export const agentActivityRawResponseDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawResponseLimitBytes).nullable(),
});

export const agentActivityRawEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  request: agentActivityRawRequestDocumentSchema.nullable(),
  response: agentActivityRawResponseDocumentSchema.nullable(),
  metadata: z
    .record(z.string().min(1).max(100), z.string().max(4_000))
    .refine((value) => Object.keys(value).length <= 32, {
      message: "Raw capture metadata may contain at most 32 entries.",
    }),
});

export const agentActivityTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .safe();
const agentCommandOutputSchema = z.string().superRefine((value, context) => {
  const size = new TextEncoder().encode(value).byteLength;
  if (size <= agentCommandOutputLimitBytes) return;
  context.addIssue({
    code: "custom",
    message: `Agent command output may contain at most ${agentCommandOutputLimitBytes} encoded bytes.`,
  });
});
export const codexEventCorrelationSchema = z.object({
  sourceMethod: z.string().min(1).max(200),
  diagnosticId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  itemId: z.string().min(1).max(200).nullable(),
});

export const agentScopeSchema = z
  .object({
    agentThreadId: z.string().min(1).max(200),
    rootThreadId: z.string().min(1).max(200),
    parentThreadId: z.string().min(1).max(200).nullable(),
    rootTurnId: z.string().min(1).max(200),
    agentPath: z.array(z.string().min(1).max(200)).max(32),
    nickname: z.string().min(1).max(200).nullable(),
    role: z.string().min(1).max(500).nullable(),
    depth: z.number().int().nonnegative().max(32),
    isRoot: z.boolean(),
  })
  .strict();

export const agentCommunicationKindSchema = z.enum([
  "spawned",
  "messageSent",
  "followupSent",
  "waiting",
  "statusChanged",
  "interrupted",
  "returned",
  "failed",
]);

const agentActivityBaseShape = {
  id: z.string().min(1),
  status: agentActivityStatusSchema,
  startedAtMs: agentActivityTimestampSchema.optional(),
  updatedAtMs: agentActivityTimestampSchema.optional(),
  completedAtMs: agentActivityTimestampSchema.nullable().optional(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
  raw: agentActivityRawEnvelopeSchema.optional(),
};

export const agentTokenUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
});

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});

export const agentActivitySchema = z.discriminatedUnion("type", [
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("instructionContext"),
    provenance: z.enum(["exact", "assembled", "unavailable"]),
    text: z.string().max(agentActivityRawRequestLimitBytes).nullable(),
    sources: z.array(z.string().min(1).max(500)).max(100),
    model: z.string().max(200).nullable(),
    provider: z.string().max(200).nullable(),
    reasoningEffort: z.string().max(100).nullable(),
    collaborationMode: z.string().max(100).nullable(),
    permissionProfile: z.string().max(200).nullable(),
    runtimeVersion: z.string().max(100).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("command"),
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    output: z.string().nullable(),
    outputTail: agentCommandOutputSchema.nullable().optional(),
    outputTruncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("fileChange"),
    changes: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["add", "delete", "update"]),
        latestLine: z
          .string()
          .max(agentFilePreviewLimitCharacters)
          .nullable()
          .optional(),
        diffPreview: z
          .string()
          .max(agentFilePreviewLimitCharacters)
          .nullable()
          .optional(),
        lastActivityAtMs: agentActivityTimestampSchema.optional(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("worktree"),
    operation: z.string().min(1),
    summary: z.string().min(1),
    worktreeId: z.string().min(1).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("plan"),
    text: z.string(),
    explanation: z.string().nullable(),
    steps: z.array(
      z.object({
        step: z.string().min(1),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reasoning"),
    summary: z.array(z.string().min(1)).max(100),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("mcpToolCall"),
    server: z.string().min(1),
    tool: z.string().min(1),
    query: z.string().max(4_000).nullable().optional(),
    resultText: z.string().max(20_000).nullable().optional(),
    error: z.string().nullable(),
    errorCode: z.string().min(1).max(200).nullable().optional(),
    retryable: z.boolean().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("dynamicToolCall"),
    namespace: z.string().min(1).nullable(),
    tool: z.string().min(1),
    success: z.boolean().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("collabToolCall"),
    tool: z.string().min(1),
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)).max(100),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    agentStates: z.array(
      z.object({
        threadId: z.string().min(1),
        status: z.string().min(1),
        message: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("subAgent"),
    kind: z.enum(["started", "interacted", "interrupted"]),
    agentThreadId: z.string().min(1),
    agentPath: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("agentCommunication"),
    kind: agentCommunicationKindSchema,
    senderThreadId: z.string().min(1).max(200),
    receiverThreadIds: z.array(z.string().min(1).max(200)).max(100),
    message: z.string().max(100_000).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("webSearch"),
    query: z.string(),
    action: z.string().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("imageView"),
    path: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reviewMode"),
    state: z.enum(["entered", "exited"]),
    review: z.string(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("contextCompaction"),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("notice"),
    level: z.enum(["warning", "error"]),
    message: z.string().min(1),
    details: z.string().nullable(),
    willRetry: z.boolean().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("usage"),
    total: agentTokenUsageSchema,
    last: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("rateLimit"),
    limitId: z.string().nullable().default(null),
    limitName: z.string().nullable(),
    planType: z.string().nullable(),
    reachedType: z.string().nullable(),
    primary: rateLimitWindowSchema.nullable(),
    secondary: rateLimitWindowSchema.nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("turnSummary"),
    durationMs: z.number().int().nonnegative().nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    completedAt: z.number().int().nonnegative().nullable(),
  }),
]);

export type AgentMessagePhase = z.infer<typeof agentMessagePhaseSchema>;
export type CodexEventCorrelation = z.infer<typeof codexEventCorrelationSchema>;
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentCommunicationKind = z.infer<
  typeof agentCommunicationKindSchema
>;
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;
export type AgentActivityRawEnvelope = z.infer<
  typeof agentActivityRawEnvelopeSchema
>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type WorkerObservationEventIdentity = z.infer<
  typeof workerObservationEventIdentitySchema
>;
