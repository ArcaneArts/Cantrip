import type {
  ProtectedProviderCredential,
  ProtectedSecretEnvelope,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol";

export function protectedSecretEnvelopeFixture(
  fill = "A",
): ProtectedSecretEnvelope {
  return {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: fill.repeat(16),
      ciphertext: fill.repeat(22),
    },
  };
}

export function protectedProviderCredentialFixture(
  fill = "A",
): ProtectedProviderCredential {
  return {
    subjectBlindIndex: fill.repeat(43),
    protectedCredential: protectedSecretEnvelopeFixture(fill),
  };
}

export function providerCredentialMetadataFixture(): ProviderCredentialPublicMetadata {
  return {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
