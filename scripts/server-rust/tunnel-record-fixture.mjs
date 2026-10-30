// Shared pure protocol fixture; no server/script imports.
export const tunnelRecord = {
  operationId: "66666666-6666-4666-8666-666666666666",
  revision: 1,
  protectedContent: {
    formatVersion: 1,
    domain: "tunnel-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};
