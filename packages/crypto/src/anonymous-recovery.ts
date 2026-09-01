import {
  anonymousRecoveryArtifactSchema,
  type AnonymousRecoveryArtifact,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

import {
  clearSensitiveBytes,
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  requireByteLength,
} from "./bytes.js";
import { decryptPayload, encryptPayload } from "./payload.js";

function recoveryAssociatedData(input: {
  artifactId: string;
  masterKeyRevision: number;
  ownerId: string;
  serverId: string;
}): EncryptionAssociatedData {
  return {
    component: "account-master-key",
    field: "wrapped_master_key",
    formatVersion: 1,
    keyRevision: input.masterKeyRevision,
    ownerId: input.ownerId,
    rowId: JSON.stringify([input.serverId, input.artifactId]),
    table: "anonymous_recovery_artifacts",
  };
}

export async function createAnonymousRecoveryArtifact(input: {
  accountMasterKey: Uint8Array;
  masterKeyRevision: number;
  ownerId: string;
  serverId: string;
}): Promise<AnonymousRecoveryArtifact> {
  requireByteLength(input.accountMasterKey, 32, "Account Master Key");
  const artifactId = crypto.randomUUID();
  const recoverySecret = randomBytes(32);
  try {
    return anonymousRecoveryArtifactSchema.parse({
      artifactId,
      createdAt: new Date().toISOString(),
      envelope: await encryptPayload({
        associatedData: recoveryAssociatedData({
          artifactId,
          masterKeyRevision: input.masterKeyRevision,
          ownerId: input.ownerId,
          serverId: input.serverId,
        }),
        key: recoverySecret,
        plaintext: input.accountMasterKey,
      }),
      masterKeyRevision: input.masterKeyRevision,
      ownerId: input.ownerId,
      purpose: "anonymous-account-recovery",
      recoverySecret: encodeBase64Url(recoverySecret),
      serverId: input.serverId,
      version: 1,
    });
  } finally {
    clearSensitiveBytes(recoverySecret);
  }
}

export async function openAnonymousRecoveryArtifact(
  value: unknown,
): Promise<Uint8Array> {
  const artifact = anonymousRecoveryArtifactSchema.parse(value);
  const recoverySecret = decodeBase64Url(artifact.recoverySecret);
  try {
    const accountMasterKey = await decryptPayload({
      associatedData: recoveryAssociatedData(artifact),
      envelope: artifact.envelope,
      key: recoverySecret,
    });
    requireByteLength(accountMasterKey, 32, "Account Master Key");
    return accountMasterKey;
  } finally {
    clearSensitiveBytes(recoverySecret);
  }
}
