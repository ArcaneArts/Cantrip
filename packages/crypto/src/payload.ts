import {
  encryptedPayloadEnvelopeSchema,
  type EncryptedPayloadEnvelope,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

import { encodeAssociatedData } from "./associated-data.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  requireByteLength,
  toArrayBuffer,
} from "./bytes.js";

export class CantripDecryptionError extends Error {
  constructor() {
    super("Encrypted material could not be authenticated.");
    this.name = "CantripDecryptionError";
  }
}

async function importAesKey(key: Uint8Array, usage: KeyUsage) {
  requireByteLength(key, 32);
  return globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

export async function encryptPayload(input: {
  key: Uint8Array;
  plaintext: Uint8Array;
  associatedData: EncryptionAssociatedData;
}): Promise<EncryptedPayloadEnvelope> {
  const nonce = randomBytes(12);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(encodeAssociatedData(input.associatedData)),
      tagLength: 128,
    },
    await importAesKey(input.key, "encrypt"),
    toArrayBuffer(input.plaintext),
  );
  return encryptedPayloadEnvelopeSchema.parse({
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: input.associatedData.keyRevision,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  });
}

export async function decryptPayload(input: {
  key: Uint8Array;
  envelope: EncryptedPayloadEnvelope;
  associatedData: EncryptionAssociatedData;
}): Promise<Uint8Array> {
  try {
    const envelope = encryptedPayloadEnvelopeSchema.parse(input.envelope);
    if (envelope.keyRevision !== input.associatedData.keyRevision) {
      throw new CantripDecryptionError();
    }
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64Url(envelope.nonce)),
        additionalData: toArrayBuffer(
          encodeAssociatedData(input.associatedData),
        ),
        tagLength: 128,
      },
      await importAesKey(input.key, "decrypt"),
      toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new CantripDecryptionError();
  }
}

export function serializePayloadEnvelope(
  input: EncryptedPayloadEnvelope,
): string {
  const envelope = encryptedPayloadEnvelopeSchema.parse(input);
  return JSON.stringify({
    algorithm: envelope.algorithm,
    ciphertext: envelope.ciphertext,
    keyRevision: envelope.keyRevision,
    nonce: envelope.nonce,
    version: envelope.version,
  });
}

export function parsePayloadEnvelope(value: string): EncryptedPayloadEnvelope {
  return encryptedPayloadEnvelopeSchema.parse(JSON.parse(value));
}
