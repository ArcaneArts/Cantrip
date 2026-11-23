export const id = (n) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
export function opaque() {
  return {
    formatVersion: 1,
    domain: "client-control-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  };
}
export const input = (n = 1, operation = "observation.snapshot") => ({
  operationId: id(n),
  operation,
  protectedContent: opaque(),
  previewLeaseId: "22222222-2222-4222-8222-222222222222",
});
