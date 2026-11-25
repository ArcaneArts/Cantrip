import { z } from "zod";

import {
  standaloneChatIdentitySchema,
  standaloneChatRootStatusSchema,
} from "./chats.js";
import { encryptedPayloadEnvelopeSchema } from "./encryption.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";

const rolePlaintextLimit = 32 * 1_024;
// The endpoint seals the role with chat-content and associated data for the
// council_agents row, agent ID, and role field.
const councilRoleEnvelopeSchema = encryptedPayloadEnvelopeSchema.extend({
  ciphertext: encryptedPayloadEnvelopeSchema.shape.ciphertext.max(
    Math.ceil(((rolePlaintextLimit + 16) * 4) / 3),
  ),
});

export const councilAgentTurnContextSchema = z
  .object({
    protectedRole: councilRoleEnvelopeSchema,
    primary: z.boolean(),
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
    expectedRevision: z.number().int().positive().max(2_147_483_647),
    titleProtection: councilAgentTitleSchema.optional(),
    protectedRole: councilRoleEnvelopeSchema.optional(),
    primary: z.boolean().optional(),
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
  })
  .strict();

export const councilAgentWireListSchema = z.array(
  councilAgentWireSummarySchema,
);

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
