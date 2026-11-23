import { createHash, randomUUID } from "node:crypto";

import {
  encryptedPolicyCreateSchema,
  type EncryptedPolicyCreate,
} from "@cantrip/protocol/policies";

function bytes(seed: string, count: number): string {
  return createHash("sha256")
    .update(seed)
    .digest()
    .subarray(0, count)
    .toString("base64url");
}

function protectedContent(seed: string) {
  return {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: bytes(`${seed}:nonce`, 12),
      ciphertext: bytes(`${seed}:ciphertext`, 32),
    },
  };
}

export function opaquePolicyCreate(
  seed: string,
  options: Partial<
    Pick<
      EncryptedPolicyCreate,
      "audience" | "enabled" | "id" | "mandatory" | "templateKey"
    >
  > = {},
): EncryptedPolicyCreate {
  return encryptedPolicyCreateSchema.parse({
    id: options.id ?? randomUUID(),
    content: {
      keyBlindIndex: bytes(`${seed}:key`, 32),
      protectedSummary: protectedContent(`${seed}:summary`),
      protectedBody: protectedContent(`${seed}:body`),
    },
    enabled: options.enabled ?? true,
    mandatory: options.mandatory ?? false,
    audience: options.audience ?? "ide",
    templateKey: options.templateKey ?? null,
  });
}
