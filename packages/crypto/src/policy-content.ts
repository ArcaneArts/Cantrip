import {
  encryptedPolicyBodyContentSchema,
  encryptedPolicySummaryContentSchema,
  policyOpaqueDetailContentSchema,
  policyProtectedBodyContentSchema,
  policyProtectedSummaryContentSchema,
  POLICY_BODY_PROTECTED_BYTES_LIMIT,
  POLICY_SUMMARY_PROTECTED_BYTES_LIMIT,
  type EncryptedPolicyBodyContent,
  type EncryptedPolicySummaryContent,
  type PolicyOpaqueDetailContent,
  type PolicyProtectedBodyContent,
  type PolicyProtectedSummaryContent,
} from "@cantrip/protocol/policies";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

import { clearSensitiveBytes } from "./bytes.js";
import {
  computeBlindLookupTag,
  deriveFieldKey,
  deriveLookupKey,
} from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const formatVersion = 1 as const;

interface Parser<T> {
  parse(value: unknown): T;
}

interface ProtectedEnvelope {
  formatVersion: 1;
  keyRevision: number;
  envelope: EncryptedPayloadEnvelope;
}

function associatedData(input: {
  ownerId: string;
  policyId: string;
  field: "protected_summary" | "protected_body";
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "policy-content",
    table: "policies",
    rowId: input.policyId,
    field: input.field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

async function encryptContent<T, E extends ProtectedEnvelope>(input: {
  componentKey: Uint8Array;
  content: T;
  contentSchema: Parser<T>;
  envelopeSchema: Parser<E>;
  associatedData: EncryptionAssociatedData;
  maximumBytes: number;
}): Promise<E> {
  const plaintext = encoder.encode(
    JSON.stringify(input.contentSchema.parse(input.content)),
  );
  if (plaintext.byteLength > input.maximumBytes) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected policy content exceeds its byte limit.");
  }
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.associatedData.ownerId,
    component: "policy-content",
    table: "policies",
    field: input.associatedData.field,
    keyRevision: input.associatedData.keyRevision,
  });
  try {
    return input.envelopeSchema.parse({
      formatVersion,
      keyRevision: input.associatedData.keyRevision,
      envelope: await encryptPayload({
        key: fieldKey,
        plaintext,
        associatedData: input.associatedData,
      }),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

async function decryptContent<T, E extends ProtectedEnvelope>(input: {
  componentKey: Uint8Array;
  encrypted: E;
  envelopeSchema: Parser<E>;
  contentSchema: Parser<T>;
  associatedData: EncryptionAssociatedData;
  maximumBytes: number;
}): Promise<T> {
  const encrypted = input.envelopeSchema.parse(input.encrypted);
  if (encrypted.keyRevision !== input.associatedData.keyRevision) {
    throw new CantripDecryptionError();
  }
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.associatedData.ownerId,
    component: "policy-content",
    table: "policies",
    field: input.associatedData.field,
    keyRevision: input.associatedData.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: encrypted.envelope,
      associatedData: input.associatedData,
    });
    if (plaintext.byteLength > input.maximumBytes) {
      throw new CantripDecryptionError();
    }
    return input.contentSchema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(fieldKey);
  }
}

export async function encryptPolicyContent(input: {
  ownerId: string;
  policyId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  summary: PolicyProtectedSummaryContent;
  body: PolicyProtectedBodyContent;
}): Promise<PolicyOpaqueDetailContent> {
  const summary = policyProtectedSummaryContentSchema.parse(input.summary);
  const lookupKey = deriveLookupKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: "policy-content",
    table: "policies",
    field: "key",
    keyRevision: input.keyRevision,
  });
  try {
    return policyOpaqueDetailContentSchema.parse({
      keyBlindIndex: computeBlindLookupTag(lookupKey, summary.key),
      protectedSummary: await encryptPolicySummaryContent({
        ...input,
        content: summary,
      }),
      protectedBody: await encryptPolicyBodyContent({
        ...input,
        content: input.body,
      }),
    });
  } finally {
    clearSensitiveBytes(lookupKey);
  }
}

export async function encryptPolicySummaryContent(input: {
  ownerId: string;
  policyId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: PolicyProtectedSummaryContent;
}): Promise<EncryptedPolicySummaryContent> {
  return encryptContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: policyProtectedSummaryContentSchema,
    envelopeSchema: encryptedPolicySummaryContentSchema,
    associatedData: associatedData({ ...input, field: "protected_summary" }),
    maximumBytes: POLICY_SUMMARY_PROTECTED_BYTES_LIMIT,
  });
}

export async function encryptPolicyBodyContent(input: {
  ownerId: string;
  policyId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: PolicyProtectedBodyContent;
}): Promise<EncryptedPolicyBodyContent> {
  return encryptContent({
    componentKey: input.componentKey,
    content: input.content,
    contentSchema: policyProtectedBodyContentSchema,
    envelopeSchema: encryptedPolicyBodyContentSchema,
    associatedData: associatedData({ ...input, field: "protected_body" }),
    maximumBytes: POLICY_BODY_PROTECTED_BYTES_LIMIT,
  });
}

export async function decryptPolicySummaryContent(input: {
  ownerId: string;
  policyId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedPolicySummaryContent;
}): Promise<PolicyProtectedSummaryContent> {
  return decryptContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedPolicySummaryContentSchema,
    contentSchema: policyProtectedSummaryContentSchema,
    associatedData: associatedData({ ...input, field: "protected_summary" }),
    maximumBytes: POLICY_SUMMARY_PROTECTED_BYTES_LIMIT,
  });
}

export async function decryptPolicyBodyContent(input: {
  ownerId: string;
  policyId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: EncryptedPolicyBodyContent;
}): Promise<PolicyProtectedBodyContent> {
  return decryptContent({
    componentKey: input.componentKey,
    encrypted: input.encrypted,
    envelopeSchema: encryptedPolicyBodyContentSchema,
    contentSchema: policyProtectedBodyContentSchema,
    associatedData: associatedData({ ...input, field: "protected_body" }),
    maximumBytes: POLICY_BODY_PROTECTED_BYTES_LIMIT,
  });
}
