import {
  clearSensitiveBytes,
  decryptPolicyBodyContent,
  decryptPolicySummaryContent,
} from "@cantrip/crypto";
import {
  agentPolicyContextSchema,
  effectivePolicyListSchema,
  effectivePolicyWireListSchema,
  policyCliListResultSchema,
  policyCliReadResultSchema,
  policyWireDetailSchema,
  standalonePolicyWireListSchema,
  POLICY_CONTEXT_BYTES_LIMIT,
  type EffectivePolicyList,
  type PolicyCliReadResult,
} from "@cantrip/protocol/policies";

import type { WorkerEncryptionService } from "./worker-encryption.js";

async function openSummary(input: {
  policyId: string;
  protectedSummary: Parameters<
    typeof decryptPolicySummaryContent
  >[0]["encrypted"];
  service: WorkerEncryptionService;
}) {
  const component = input.service.componentKey("policy-content");
  try {
    return decryptPolicySummaryContent({
      ownerId: input.service.ownerId(),
      policyId: input.policyId,
      keyRevision: input.protectedSummary.keyRevision,
      componentKey: component.key,
      encrypted: input.protectedSummary,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openEffectivePolicies(input: {
  policies: unknown;
  service: WorkerEncryptionService;
}): Promise<EffectivePolicyList> {
  const wire = effectivePolicyWireListSchema.parse(input.policies);
  return effectivePolicyListSchema.parse({
    policies: await Promise.all(
      wire.policies.map(async (policy) => {
        const summary = await openSummary({
          policyId: policy.id,
          protectedSummary: policy.protectedSummary,
          service: input.service,
        });
        return {
          key: summary.key,
          name: summary.name,
          summary: summary.summary,
          mandatory: policy.mandatory,
          sources: policy.sources,
        };
      }),
    ),
  });
}

export async function buildEncryptedAgentPolicyContext(input: {
  policies: unknown;
  projectId: string;
  service: WorkerEncryptionService;
}): Promise<string | null> {
  const { policies } = await openEffectivePolicies(input);
  if (!policies.length) return null;
  const context = [
    "Effective Cantrip policies apply to this project.",
    ...policies.map(({ key, name, summary }) => `[${key}] ${name}\n${summary}`),
  ].join("\n\n");
  const bytes = Buffer.byteLength(context, "utf8");
  if (bytes > POLICY_CONTEXT_BYTES_LIMIT) {
    throw new Error(
      `Project ${input.projectId} has ${policies.length} effective policies requiring ${bytes} context bytes, above the ${POLICY_CONTEXT_BYTES_LIMIT}-byte limit. Reduce or consolidate its effective policies before starting another Agent turn.`,
    );
  }
  return agentPolicyContextSchema.parse(context);
}

export async function buildStandalonePolicyContext(input: {
  policies: unknown;
  service: WorkerEncryptionService;
}): Promise<string | null> {
  const wire = standalonePolicyWireListSchema.parse(input.policies);
  if (!wire.policies.length) return null;
  const policies = await Promise.all(
    wire.policies.map(async (policy) => {
      const summary = await openSummary({
        policyId: policy.id,
        protectedSummary: policy.protectedSummary,
        service: input.service,
      });
      const component = input.service.componentKey("policy-content");
      try {
        const body = await decryptPolicyBodyContent({
          ownerId: input.service.ownerId(),
          policyId: policy.id,
          keyRevision: policy.protectedBody.keyRevision,
          componentKey: component.key,
          encrypted: policy.protectedBody,
        });
        return { ...summary, bodyMarkdown: body.bodyMarkdown };
      } finally {
        clearSensitiveBytes(component.key);
      }
    }),
  );
  const context = [
    "The following enabled Cantrip Policies apply to this standalone Chat. Follow each full Policy body directly; managed Cantrip policy tools are unavailable in this context.",
    ...policies.map(
      ({ bodyMarkdown, key, name }) =>
        `## Policy: ${name} (${key})\n\n${bodyMarkdown}`,
    ),
  ].join("\n\n");
  const bytes = Buffer.byteLength(context, "utf8");
  if (bytes > POLICY_CONTEXT_BYTES_LIMIT) {
    throw new Error(
      `Standalone Chat has ${policies.length} effective policies requiring ${bytes} context bytes, above the ${POLICY_CONTEXT_BYTES_LIMIT}-byte limit. Reduce or consolidate Chat policies before starting another turn.`,
    );
  }
  return agentPolicyContextSchema.parse(context);
}

export async function openPolicyCliList(input: {
  policies: unknown;
  service: WorkerEncryptionService;
}) {
  return policyCliListResultSchema.parse(
    await openEffectivePolicies({
      policies: input.policies,
      service: input.service,
    }),
  );
}

export async function openPolicyCliDetail(input: {
  policy: unknown;
  service: WorkerEncryptionService;
}): Promise<PolicyCliReadResult> {
  const policy = policyWireDetailSchema.parse(input.policy);
  const summary = await openSummary({
    policyId: policy.id,
    protectedSummary: policy.content.protectedSummary,
    service: input.service,
  });
  const component = input.service.componentKey("policy-content");
  try {
    const body = await decryptPolicyBodyContent({
      ownerId: input.service.ownerId(),
      policyId: policy.id,
      keyRevision: policy.content.protectedBody.keyRevision,
      componentKey: component.key,
      encrypted: policy.content.protectedBody,
    });
    return policyCliReadResultSchema.parse({
      policy: { ...summary, bodyMarkdown: body.bodyMarkdown },
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}
