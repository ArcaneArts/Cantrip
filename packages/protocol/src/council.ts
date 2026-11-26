import { z } from "zod";

import {
  standaloneChatIdentitySchema,
  standaloneChatRootStatusSchema,
  standaloneChatWireSummarySchema,
} from "./chats.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { modelProviderAccountWireSummarySchema } from "./providers.js";

const rolePlaintextLimit = 32 * 1_024;
export const COUNCIL_MEMORY_BYTE_LIMIT = 8 * 1_024;
const revisionSchema = z.number().int().positive().max(2_147_483_647);
const recoveryAccountSchema = modelProviderAccountWireSummarySchema
  .pick({ id: true, protectedLabel: true })
  .nullable()
  .default(null);

export const councilConversationWireSchema =
  standaloneChatWireSummarySchema.safeExtend({
    providerRecovery: z
      .object({
        phase: z.enum([
          "pending",
          "blocked",
          "switching",
          "continuation-queued",
          "continued",
        ]),
        from: z.string().min(1),
        to: z.string().min(1).nullable(),
        fromAccount: recoveryAccountSchema,
        toAccount: recoveryAccountSchema,
      })
      .strict()
      .nullable()
      .default(null),
  });
// The endpoint seals the role with chat-content and associated data for the
// council_agents row, agent ID, and role field.
const councilRoleEnvelopeSchema = encryptedPayloadEnvelopeSchema.extend({
  ciphertext: encryptedPayloadEnvelopeSchema.shape.ciphertext.max(
    Math.ceil(((rolePlaintextLimit + 16) * 4) / 3),
  ),
});

const councilMemoryEnvelopeSchema = encryptedPayloadEnvelopeSchema.extend({
  ciphertext: encryptedPayloadEnvelopeSchema.shape.ciphertext.max(
    Math.ceil(((COUNCIL_MEMORY_BYTE_LIMIT + 16) * 4) / 3),
  ),
});

export const councilAgentTurnContextSchema = z
  .object({
    protectedRole: councilRoleEnvelopeSchema,
    primary: z.boolean(),
    protectedMemory: councilMemoryEnvelopeSchema.nullable().optional(),
    historyEpoch: z.uuid().optional(),
  })
  .strict();

const councilAgentTitleSchema = privateDisplayLabelOpaqueSchema.extend({
  classification: z.object({ recordKind: z.literal("chat") }).strict(),
});

export const councilAgentCreateSchema = z
  .object({
    id: standaloneChatIdentitySchema,
    titleProtection: councilAgentTitleSchema,
    protectedRole: councilRoleEnvelopeSchema,
  })
  .strict();

export const councilAgentUpdateSchema = z
  .object({
    expectedRevision: revisionSchema,
    titleProtection: councilAgentTitleSchema.optional(),
    protectedRole: councilRoleEnvelopeSchema.optional(),
    primary: z.boolean().optional(),
    hidden: z.boolean().optional(),
    paused: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const councilAgentWireSummarySchema = z
  .object({
    id: standaloneChatIdentitySchema,
    workerId: z.string().min(1),
    titleProtection: councilAgentTitleSchema,
    protectedRole: councilRoleEnvelopeSchema,
    primary: z.boolean(),
    revision: z.number().int().positive(),
    scratchStatus: standaloneChatRootStatusSchema,
    hidden: z.boolean().default(false),
    paused: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .strict();

export const councilAgentWireListSchema = z.array(
  councilAgentWireSummarySchema,
);

export const councilMemoryWireSchema = z
  .object({
    agentId: standaloneChatIdentitySchema,
    revision: revisionSchema,
    protectedMemory: councilMemoryEnvelopeSchema.nullable(),
  })
  .strict();

export const councilMemoryUpdateSchema = z
  .object({
    expectedRevision: revisionSchema,
    protectedMemory: councilMemoryEnvelopeSchema.nullable(),
  })
  .strict();

const councilToolAgentSchema = z
  .object({
    id: standaloneChatIdentitySchema,
    title: z.string().min(1).max(120),
    primary: z.boolean(),
    scratchStatus: standaloneChatRootStatusSchema,
  })
  .strict();

export const councilListToolInputSchema = z.object({}).strict();
export const councilCreateToolInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(rolePlaintextLimit),
  })
  .strict();
export const councilMemoryReadToolInputSchema = z.object({}).strict();
export const councilMemoryWriteToolInputSchema = z
  .object({
    expectedRevision: revisionSchema,
    text: z.string().max(COUNCIL_MEMORY_BYTE_LIMIT),
  })
  .strict();
const councilToolMemorySchema = z
  .object({
    revision: revisionSchema,
    text: z.string().max(COUNCIL_MEMORY_BYTE_LIMIT),
  })
  .strict();
export const councilMemoryReadToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({ data: councilToolMemorySchema });
export const councilMemoryWriteToolOutputSchema =
  councilMemoryReadToolOutputSchema.extend({ mutated: z.literal(true) });
export const councilListToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: z.object({ agents: z.array(councilToolAgentSchema) }).strict(),
  });
export const councilCreateToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: z.object({ agent: councilToolAgentSchema }).strict(),
  });

export type CouncilAgentCreate = z.infer<typeof councilAgentCreateSchema>;
export type CouncilAgentUpdate = z.infer<typeof councilAgentUpdateSchema>;
export type CouncilAgentWireSummary = z.infer<
  typeof councilAgentWireSummarySchema
>;
