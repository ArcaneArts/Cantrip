import { z } from "zod";

export const POLICY_LIMIT = 500;
export const EFFECTIVE_POLICY_LIMIT = 64;
export const POLICY_NAME_LIMIT = 120;
export const POLICY_KEY_LIMIT = 80;
export const POLICY_SUMMARY_LIMIT = 1_000;
export const POLICY_BODY_LIMIT = 100_000;
export const POLICY_CONTEXT_BYTES_LIMIT = 32 * 1_024;

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

export const effectivePolicySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mandatory") }),
  z.object({
    type: z.literal("workspace"),
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
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
  policies: z.array(effectivePolicySummarySchema).max(EFFECTIVE_POLICY_LIMIT),
});

export type PolicyTemplateSummary = z.infer<typeof policyTemplateSummarySchema>;
export type PolicyTemplateDetail = z.infer<typeof policyTemplateDetailSchema>;
export type PolicySummary = z.infer<typeof policySummarySchema>;
export type PolicyDetail = z.infer<typeof policyDetailSchema>;
export type PolicyList = z.infer<typeof policyListSchema>;
export type PolicyCreate = z.infer<typeof policyCreateSchema>;
export type PolicyUpdate = z.infer<typeof policyUpdateSchema>;
export type PolicyOrderUpdate = z.infer<typeof policyOrderUpdateSchema>;
export type PolicyAssignmentUpdate = z.infer<
  typeof policyAssignmentUpdateSchema
>;
export type EffectivePolicySource = z.infer<typeof effectivePolicySourceSchema>;
export type EffectivePolicySummary = z.infer<
  typeof effectivePolicySummarySchema
>;
export type EffectivePolicyList = z.infer<typeof effectivePolicyListSchema>;
