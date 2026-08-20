import {
  clearSensitiveBytes,
  decryptPolicyBodyContent,
  decryptPolicySummaryContent,
  encryptPolicyContent,
} from "@cantrip/crypto";
import {
  effectivePolicyListSchema,
  effectivePolicyWireListSchema,
  encryptedPolicyCreateSchema,
  encryptedPolicyUpdateSchema,
  policyAssignmentListSchema,
  policyAssignmentWireListSchema,
  policyCreateSchema,
  policyDetailSchema,
  policyListSchema,
  policySummarySchema,
  policyUpdateSchema,
  policyWireDetailSchema,
  policyWireListSchema,
  policyWireSummarySchema,
  type EffectivePolicyList,
  type EncryptedPolicyCreate,
  type EncryptedPolicyUpdate,
  type PolicyAssignmentList,
  type PolicyCreate,
  type PolicyDetail,
  type PolicyList,
  type PolicyUpdate,
  type PolicyWireDetail,
  type PolicyWireList,
  type PolicyWireSummary,
} from "@cantrip/protocol/policies";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    identity: { ownerId: session.user.id, serverId: session.serverId },
    keyRevision: snapshot.masterKeyRevision,
    service,
  };
}

async function openSummary(policy: PolicyWireSummary, options: TrustedOptions) {
  const context = encryptionContext(options);
  const keyRevision = policy.content.protectedSummary.keyRevision;
  const componentKey = context.service.componentKey({
    component: "policy-content",
    identity: context.identity,
    keyRevision,
  });
  try {
    return decryptPolicySummaryContent({
      ownerId: context.identity.ownerId,
      policyId: policy.id,
      keyRevision,
      componentKey,
      encrypted: policy.content.protectedSummary,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openPolicyWireSummary(
  raw: unknown,
  options: TrustedOptions = {},
) {
  const policy = policyWireSummarySchema.parse(raw);
  const summary = await openSummary(policy, options);
  return policySummarySchema.parse({
    ...policy,
    content: undefined,
    key: summary.key,
    name: summary.name,
    summary: summary.summary,
  });
}

export async function openPolicyWireDetail(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<PolicyDetail> {
  const policy = policyWireDetailSchema.parse(raw);
  const context = encryptionContext(options);
  const keyRevision = policy.content.protectedBody.keyRevision;
  const componentKey = context.service.componentKey({
    component: "policy-content",
    identity: context.identity,
    keyRevision,
  });
  try {
    const [summary, body] = await Promise.all([
      openSummary(policy, options),
      decryptPolicyBodyContent({
        ownerId: context.identity.ownerId,
        policyId: policy.id,
        keyRevision,
        componentKey,
        encrypted: policy.content.protectedBody,
      }),
    ]);
    return policyDetailSchema.parse({
      ...policy,
      content: undefined,
      key: summary.key,
      name: summary.name,
      summary: summary.summary,
      bodyMarkdown: body.bodyMarkdown,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openPolicyWireList(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<PolicyList> {
  const list = policyWireListSchema.parse(raw);
  return policyListSchema.parse({
    collectionVersion: list.collectionVersion,
    policies: await Promise.all(
      list.policies.map((policy) => openPolicyWireSummary(policy, options)),
    ),
  });
}

export async function openPolicyAssignmentWireList(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<PolicyAssignmentList> {
  const list = policyAssignmentWireListSchema.parse(raw);
  return policyAssignmentListSchema.parse({
    collectionVersion: list.collectionVersion,
    policies: await Promise.all(
      list.policies.map((policy) => openPolicyWireSummary(policy, options)),
    ),
    directPolicyIds: list.directPolicyIds,
  });
}

export async function openEffectivePolicyWireList(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<EffectivePolicyList> {
  const list = effectivePolicyWireListSchema.parse(raw);
  const context = encryptionContext(options);
  const policies = await Promise.all(
    list.policies.map(async (policy) => {
      const keyRevision = policy.protectedSummary.keyRevision;
      const componentKey = context.service.componentKey({
        component: "policy-content",
        identity: context.identity,
        keyRevision,
      });
      try {
        const summary = await decryptPolicySummaryContent({
          ownerId: context.identity.ownerId,
          policyId: policy.id,
          keyRevision,
          componentKey,
          encrypted: policy.protectedSummary,
        });
        return {
          key: summary.key,
          name: summary.name,
          summary: summary.summary,
          mandatory: policy.mandatory,
          sources: policy.sources,
        };
      } finally {
        clearSensitiveBytes(componentKey);
      }
    }),
  );
  return effectivePolicyListSchema.parse({ policies });
}

export async function protectPolicyCreate(
  rawInput: PolicyCreate,
  templateKey: string | null = null,
  options: TrustedOptions = {},
): Promise<EncryptedPolicyCreate> {
  const input = policyCreateSchema.parse(rawInput);
  const context = encryptionContext(options);
  const id = crypto.randomUUID();
  const componentKey = context.service.componentKey({
    component: "policy-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    return encryptedPolicyCreateSchema.parse({
      id,
      content: await encryptPolicyContent({
        ownerId: context.identity.ownerId,
        policyId: id,
        keyRevision: context.keyRevision,
        componentKey,
        summary: {
          version: 1,
          key: input.key,
          name: input.name,
          summary: input.summary,
        },
        body: { version: 1, bodyMarkdown: input.bodyMarkdown },
      }),
      enabled: input.enabled,
      mandatory: input.mandatory,
      templateKey,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function protectPolicyUpdate(
  policyId: string,
  current: PolicyDetail,
  rawInput: PolicyUpdate,
  options: TrustedOptions = {},
): Promise<EncryptedPolicyUpdate> {
  const input = policyUpdateSchema.parse(rawInput);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "policy-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  const contentChanged =
    input.name !== undefined ||
    input.summary !== undefined ||
    input.bodyMarkdown !== undefined;
  try {
    const content = contentChanged
      ? await encryptPolicyContent({
          ownerId: context.identity.ownerId,
          policyId,
          keyRevision: context.keyRevision,
          componentKey,
          summary: {
            version: 1,
            key: current.key,
            name: input.name ?? current.name,
            summary: input.summary ?? current.summary,
          },
          body: {
            version: 1,
            bodyMarkdown: input.bodyMarkdown ?? current.bodyMarkdown,
          },
        })
      : null;
    return encryptedPolicyUpdateSchema.parse({
      rowVersion: input.rowVersion,
      ...(content
        ? {
            content: {
              protectedSummary: content.protectedSummary,
              protectedBody: content.protectedBody,
            },
          }
        : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.mandatory === undefined ? {} : { mandatory: input.mandatory }),
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export function policyWireBootstrapVersion(raw: unknown): number {
  return policyWireListSchema.parse(raw).bootstrapVersion;
}

export function parsePolicyWireList(raw: unknown): PolicyWireList {
  return policyWireListSchema.parse(raw);
}

export function parsePolicyWireDetail(raw: unknown): PolicyWireDetail {
  return policyWireDetailSchema.parse(raw);
}
