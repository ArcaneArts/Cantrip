import type {
  AttachmentChunkOpaque,
  AttachmentProtectedMetadata,
} from "@cantrip/protocol/attachment-content";

function opaqueCiphertext(label: string): string {
  return Buffer.from(`opaque:${label}`.padEnd(32, "x")).toString("base64url");
}

export function protectedAttachmentMetadataFixture(
  label = "attachment-metadata",
): AttachmentProtectedMetadata {
  return {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12, 7).toString("base64url"),
      ciphertext: opaqueCiphertext(label),
    },
  };
}

export function protectedAttachmentChunkFixture(input: {
  eof: boolean;
  plaintextBytes: number;
  sequence: number;
}): AttachmentChunkOpaque {
  return {
    sequence: input.sequence,
    plaintextBytes: input.plaintextBytes,
    eof: input.eof,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12, input.sequence + 1).toString("base64url"),
      ciphertext: opaqueCiphertext(`attachment-chunk:${input.sequence}`),
    },
  };
}
