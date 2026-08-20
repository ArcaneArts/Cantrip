import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const POLICY_LIMIT = 500;
export const EFFECTIVE_POLICY_LIMIT = 64;
export const POLICY_NAME_LIMIT = 120;
export const POLICY_KEY_LIMIT = 80;
export const POLICY_SUMMARY_LIMIT = 1_000;
export const POLICY_BODY_LIMIT = 100_000;
export const POLICY_CONTEXT_BYTES_LIMIT = 32 * 1_024;
export const POLICY_SUMMARY_PROTECTED_BYTES_LIMIT = 8 * 1_024;
export const POLICY_BODY_PROTECTED_BYTES_LIMIT = 128 * 1_024;
export const POLICY_BOOTSTRAP_VERSION = 2;

export const policyKeySchema = z
  .string()
  .min(1)
  .max(POLICY_KEY_LIMIT)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message:
      "Policy keys use lowercase letters, numbers, and single interior dashes.",
  });

export const policyNameSchema = z.string().trim().min(1).max(POLICY_NAME_LIMIT);
export const policySummaryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(POLICY_SUMMARY_LIMIT);
export const policyBodyMarkdownSchema = z
  .string()
  .min(1)
  .max(POLICY_BODY_LIMIT);

export const policyTemplateSummarySchema = z.object({
  templateKey: policyKeySchema,
  name: policyNameSchema,
  suggestedPolicyKey: policyKeySchema,
  summary: policySummaryTextSchema,
  version: z.number().int().positive(),
  suggestedEnabled: z.boolean(),
  suggestedMandatory: z.boolean(),
});

export const policyTemplateDetailSchema = policyTemplateSummarySchema.extend({
  bodyMarkdown: policyBodyMarkdownSchema,
});

export const policyTemplateListSchema = z
  .array(policyTemplateSummarySchema)
  .max(100);

export const policySummarySchema = z.object({
  id: z.string().min(1),
  key: policyKeySchema,
  name: policyNameSchema,
  summary: policySummaryTextSchema,
  enabled: z.boolean(),
  mandatory: z.boolean(),
  position: z.number().int().nonnegative(),
  templateKey: policyKeySchema.nullable(),
  rowVersion: z.number().int().positive(),
  workspaceAssignmentCount: z.number().int().nonnegative(),
  projectAssignmentCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const policyDetailSchema = policySummarySchema.extend({
  bodyMarkdown: policyBodyMarkdownSchema,
});

function protectedPolicyEnvelopeSchema(maximumBytes: number) {
  return z
    .object({
      formatVersion: z.literal(1),
      keyRevision: encryptionKeyRevisionSchema,
      envelope: encryptedPayloadEnvelopeSchema,
    })
    .strict()
    .refine(
      ({ envelope }) =>
        envelope.ciphertext.length <= Math.ceil(((maximumBytes + 16) * 4) / 3),
      "Encrypted policy content exceeds its byte limit.",
    );
}

export const encryptedPolicySummaryContentSchema =
  protectedPolicyEnvelopeSchema(POLICY_SUMMARY_PROTECTED_BYTES_LIMIT);
export const encryptedPolicyBodyContentSchema = protectedPolicyEnvelopeSchema(
  POLICY_BODY_PROTECTED_BYTES_LIMIT,
);

export const policyProtectedSummaryContentSchema = z
  .object({
    version: z.literal(1),
    key: policyKeySchema,
    name: policyNameSchema,
    summary: policySummaryTextSchema,
  })
  .strict();

export const policyProtectedBodyContentSchema = z
  .object({
    version: z.literal(1),
    bodyMarkdown: policyBodyMarkdownSchema,
  })
  .strict();

export const policyOpaqueSummaryContentSchema = z
  .object({
    keyBlindIndex: encryptionKeyBytesSchema,
    protectedSummary: encryptedPolicySummaryContentSchema,
  })
  .strict();

export const policyOpaqueDetailContentSchema = policyOpaqueSummaryContentSchema
  .extend({ protectedBody: encryptedPolicyBodyContentSchema })
  .strict();

const policyOperationalFieldsSchema = z.object({
  enabled: z.boolean(),
  mandatory: z.boolean(),
});

export const encryptedPolicyCreateSchema = policyOperationalFieldsSchema
  .extend({
    id: z.uuid(),
    content: policyOpaqueDetailContentSchema,
    templateKey: policyKeySchema.nullable().default(null),
  })
  .strict();

export const encryptedPolicyUpdateSchema = policyOperationalFieldsSchema
  .partial()
  .extend({
    rowVersion: z.number().int().positive(),
    content: z
      .object({
        protectedSummary: encryptedPolicySummaryContentSchema,
        protectedBody: encryptedPolicyBodyContentSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.content !== undefined ||
      value.enabled !== undefined ||
      value.mandatory !== undefined,
    { message: "At least one encrypted policy field is required." },
  );

export const encryptedPolicyBootstrapSchema = z
  .object({
    expectedBootstrapVersion: z.number().int().min(0),
    policies: z.array(encryptedPolicyCreateSchema).min(1).max(100),
  })
  .strict();

export const policyWireSummarySchema = z
  .object({
    id: z.string().min(1),
    content: policyOpaqueSummaryContentSchema,
    enabled: z.boolean(),
    mandatory: z.boolean(),
    position: z.number().int().nonnegative(),
    templateKey: policyKeySchema.nullable(),
    rowVersion: z.number().int().positive(),
    workspaceAssignmentCount: z.number().int().nonnegative(),
    projectAssignmentCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const policyWireDetailSchema = policyWireSummarySchema
  .extend({ content: policyOpaqueDetailContentSchema })
  .strict();

export const policyWireListSchema = z
  .object({
    bootstrapVersion: z.number().int().min(0),
    collectionVersion: z.number().int().positive(),
    policies: z.array(policyWireSummarySchema).max(POLICY_LIMIT),
  })
  .strict();

export const policyListSchema = z.object({
  collectionVersion: z.number().int().positive(),
  policies: z.array(policySummarySchema).max(POLICY_LIMIT),
});

export const policyCreateSchema = z.object({
  key: policyKeySchema,
  name: policyNameSchema,
  summary: policySummaryTextSchema,
  bodyMarkdown: policyBodyMarkdownSchema,
  enabled: z.boolean().default(true),
  mandatory: z.boolean().default(false),
});

export const policyUpdateSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    name: policyNameSchema.optional(),
    summary: policySummaryTextSchema.optional(),
    bodyMarkdown: policyBodyMarkdownSchema.optional(),
    enabled: z.boolean().optional(),
    mandatory: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.summary !== undefined ||
      value.bodyMarkdown !== undefined ||
      value.enabled !== undefined ||
      value.mandatory !== undefined,
    { message: "At least one policy field is required." },
  );

function uniquePolicyIds(policyIds: string[]): boolean {
  return new Set(policyIds).size === policyIds.length;
}

export const policyOrderUpdateSchema = z.object({
  collectionVersion: z.number().int().positive(),
  policyIds: z
    .array(z.string().min(1))
    .max(POLICY_LIMIT)
    .refine(uniquePolicyIds, "Policy order cannot contain duplicate IDs."),
});

export const policyAssignmentUpdateSchema = z.object({
  collectionVersion: z.number().int().positive(),
  policyIds: z
    .array(z.string().min(1))
    .max(POLICY_LIMIT)
    .refine(
      uniquePolicyIds,
      "Policy assignments cannot contain duplicate IDs.",
    ),
});

export const policyAssignmentListSchema = z
  .object({
    collectionVersion: z.number().int().positive(),
    policies: z.array(policySummarySchema).max(POLICY_LIMIT),
    directPolicyIds: z
      .array(z.string().min(1))
      .max(POLICY_LIMIT)
      .refine(
        uniquePolicyIds,
        "Direct policy assignments cannot contain duplicate IDs.",
      ),
  })
  .superRefine((value, context) => {
    const available = new Set(value.policies.map(({ id }) => id));
    for (const [index, policyId] of value.directPolicyIds.entries()) {
      if (!available.has(policyId)) {
        context.addIssue({
          code: "custom",
          message: "Direct assignments must reference a listed policy.",
          path: ["directPolicyIds", index],
        });
      }
    }
  });

export const policyAssignmentWireListSchema = z
  .object({
    collectionVersion: z.number().int().positive(),
    policies: z.array(policyWireSummarySchema).max(POLICY_LIMIT),
    directPolicyIds: z
      .array(z.string().min(1))
      .max(POLICY_LIMIT)
      .refine(
        uniquePolicyIds,
        "Direct policy assignments cannot contain duplicate IDs.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const available = new Set(value.policies.map(({ id }) => id));
    for (const [index, policyId] of value.directPolicyIds.entries()) {
      if (!available.has(policyId)) {
        context.addIssue({
          code: "custom",
          message: "Direct assignments must reference a listed policy.",
          path: ["directPolicyIds", index],
        });
      }
    }
  });

export const policyFromTemplateCreateSchema = z
  .object({
    key: policyKeySchema.optional(),
    name: policyNameSchema.optional(),
    summary: policySummaryTextSchema.optional(),
    bodyMarkdown: policyBodyMarkdownSchema.optional(),
    enabled: z.boolean().optional(),
    mandatory: z.boolean().optional(),
  })
  .strict();

export const policyTemplateResetSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    restoreDefaults: z.boolean().default(false),
  })
  .strict();

export const policyDeleteSchema = z
  .object({ rowVersion: z.number().int().positive() })
  .strict();

export const effectivePolicySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mandatory") }),
  z.object({
    type: z.literal("workspace"),
    workspaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("project"),
    projectId: z.string().min(1),
  }),
]);

export const effectivePolicySummarySchema = z.object({
  key: policyKeySchema,
  name: policyNameSchema,
  summary: policySummaryTextSchema,
  mandatory: z.boolean(),
  sources: z
    .array(effectivePolicySourceSchema)
    .min(1)
    .max(POLICY_LIMIT + 1),
});

export const effectivePolicyListSchema = z.object({
  policies: z
    .array(effectivePolicySummarySchema)
    .max(EFFECTIVE_POLICY_LIMIT)
    .refine(
      (policies) =>
        new Set(policies.map(({ key }) => key)).size === policies.length,
      "Effective policies cannot contain duplicate keys.",
    ),
});

export const effectivePolicyWireSummarySchema = z
  .object({
    id: z.string().min(1),
    protectedSummary: encryptedPolicySummaryContentSchema,
    mandatory: z.boolean(),
    sources: z
      .array(effectivePolicySourceSchema)
      .min(1)
      .max(POLICY_LIMIT + 1),
  })
  .strict();

export const effectivePolicyWireListSchema = z
  .object({
    policies: z
      .array(effectivePolicyWireSummarySchema)
      .max(EFFECTIVE_POLICY_LIMIT),
  })
  .strict();

export const policyCliWireListResultSchema = effectivePolicyWireListSchema;
export const policyCliWireReadResultSchema = z
  .object({ policy: policyWireDetailSchema })
  .strict();

export const policyCliListResultSchema = effectivePolicyListSchema;

export const policyCliReadResultSchema = z.object({
  policy: z.object({
    key: policyKeySchema,
    name: policyNameSchema,
    summary: policySummaryTextSchema,
    bodyMarkdown: policyBodyMarkdownSchema,
  }),
});

export const agentPolicyContextSchema = z
  .string()
  .max(POLICY_CONTEXT_BYTES_LIMIT)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= POLICY_CONTEXT_BYTES_LIMIT,
    `Agent policy context cannot exceed ${POLICY_CONTEXT_BYTES_LIMIT} UTF-8 bytes.`,
  );

export type PolicyTemplateSummary = z.infer<typeof policyTemplateSummarySchema>;
export type PolicyTemplateDetail = z.infer<typeof policyTemplateDetailSchema>;
export type PolicySummary = z.infer<typeof policySummarySchema>;
export type PolicyDetail = z.infer<typeof policyDetailSchema>;
export type EncryptedPolicySummaryContent = z.infer<
  typeof encryptedPolicySummaryContentSchema
>;
export type EncryptedPolicyBodyContent = z.infer<
  typeof encryptedPolicyBodyContentSchema
>;
export type PolicyProtectedSummaryContent = z.infer<
  typeof policyProtectedSummaryContentSchema
>;
export type PolicyProtectedBodyContent = z.infer<
  typeof policyProtectedBodyContentSchema
>;
export type PolicyOpaqueSummaryContent = z.infer<
  typeof policyOpaqueSummaryContentSchema
>;
export type PolicyOpaqueDetailContent = z.infer<
  typeof policyOpaqueDetailContentSchema
>;
export type EncryptedPolicyCreate = z.infer<typeof encryptedPolicyCreateSchema>;
export type EncryptedPolicyUpdate = z.infer<typeof encryptedPolicyUpdateSchema>;
export type EncryptedPolicyBootstrap = z.infer<
  typeof encryptedPolicyBootstrapSchema
>;
export type PolicyWireSummary = z.infer<typeof policyWireSummarySchema>;
export type PolicyWireDetail = z.infer<typeof policyWireDetailSchema>;
export type PolicyWireList = z.infer<typeof policyWireListSchema>;
export type PolicyList = z.infer<typeof policyListSchema>;
export type PolicyCreate = z.infer<typeof policyCreateSchema>;
export type PolicyUpdate = z.infer<typeof policyUpdateSchema>;
export type PolicyOrderUpdate = z.infer<typeof policyOrderUpdateSchema>;
export type PolicyAssignmentUpdate = z.infer<
  typeof policyAssignmentUpdateSchema
>;
export type PolicyAssignmentList = z.infer<typeof policyAssignmentListSchema>;
export type PolicyAssignmentWireList = z.infer<
  typeof policyAssignmentWireListSchema
>;
export type PolicyFromTemplateCreate = z.infer<
  typeof policyFromTemplateCreateSchema
>;
export type PolicyTemplateReset = z.infer<typeof policyTemplateResetSchema>;
export type PolicyDelete = z.infer<typeof policyDeleteSchema>;
export type EffectivePolicySource = z.infer<typeof effectivePolicySourceSchema>;
export type EffectivePolicySummary = z.infer<
  typeof effectivePolicySummarySchema
>;
export type EffectivePolicyList = z.infer<typeof effectivePolicyListSchema>;
export type EffectivePolicyWireSummary = z.infer<
  typeof effectivePolicyWireSummarySchema
>;
export type EffectivePolicyWireList = z.infer<
  typeof effectivePolicyWireListSchema
>;
export type PolicyCliListResult = z.infer<typeof policyCliListResultSchema>;
export type PolicyCliReadResult = z.infer<typeof policyCliReadResultSchema>;
