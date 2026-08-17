import {
  POLICY_CONTEXT_BYTES_LIMIT,
  agentPolicyContextSchema,
  effectivePolicyListSchema,
  type EffectivePolicyList,
} from "@cantrip/protocol/policies";

export class PolicyContextLimitError extends Error {}

export function buildAgentPolicyContext(
  rawPolicies: EffectivePolicyList,
  projectLabel: string,
): string | null {
  const { policies } = effectivePolicyListSchema.parse(rawPolicies);
  if (!policies.length) return null;

  const context = [
    "Effective Cantrip policies apply to this project.",
    ...policies.map(({ key, name, summary }) => `[${key}] ${name}\n${summary}`),
  ].join("\n\n");
  const bytes = Buffer.byteLength(context, "utf8");
  if (bytes > POLICY_CONTEXT_BYTES_LIMIT) {
    throw new PolicyContextLimitError(
      `Project ${projectLabel} has ${policies.length} effective policies requiring ${bytes} context bytes, above the ${POLICY_CONTEXT_BYTES_LIMIT}-byte limit. Reduce or consolidate its effective policies before starting another Agent turn.`,
    );
  }
  return agentPolicyContextSchema.parse(context);
}
