import {
  encryptionPublicKeySchema,
  hpkeWrappedKeyEnvelopeSchema,
  type EncryptionAssociatedData,
  type EncryptionPublicKey,
  type HpkeWrappedKeyEnvelope,
} from "@cantrip/protocol/encryption";
import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

import { encodeAssociatedData } from "./associated-data.js";
import {
  decodeBase64Url,
  encodeBase64Url,
  requireByteLength,
  toArrayBuffer,
} from "./bytes.js";
import { CantripDecryptionError } from "./payload.js";

const textEncoder = new TextEncoder();
const hpkeInfo = textEncoder.encode("cantrip:e2ee:hpke-key-wrap:v1");
const hpkeSuite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export async function generateHpkeKeyPair(
  extractablePrivateKey = false,
): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    extractablePrivateKey,
    ["deriveBits"],
  )) as CryptoKeyPair;
}

export async function exportHpkePublicKey(
  publicKey: CryptoKey,
): Promise<EncryptionPublicKey> {
  const value = new Uint8Array(
    await hpkeSuite.kem.serializePublicKey(publicKey),
  );
  return encryptionPublicKeySchema.parse({
    version: 1,
    algorithm: "P-256",
    format: "raw",
    value: encodeBase64Url(value),
  });
}

export async function importHpkePublicKey(
  input: EncryptionPublicKey,
): Promise<CryptoKey> {
  const publicKey = encryptionPublicKeySchema.parse(input);
  return hpkeSuite.kem.deserializePublicKey(
    toArrayBuffer(decodeBase64Url(publicKey.value)),
  );
}

export async function exportHpkePrivateKey(
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const value = new Uint8Array(
    await hpkeSuite.kem.serializePrivateKey(privateKey),
  );
  requireByteLength(value, 32, "HPKE private key");
  return value;
}

export async function importHpkeKeyPair(input: {
  publicKey: EncryptionPublicKey;
  privateKey: Uint8Array;
}): Promise<CryptoKeyPair> {
  requireByteLength(input.privateKey, 32, "HPKE private key");
  return {
    publicKey: await importHpkePublicKey(input.publicKey),
    privateKey: await hpkeSuite.kem.deserializePrivateKey(
      toArrayBuffer(input.privateKey),
    ),
  };
}

export async function wrapKeyForRecipient(input: {
  key: Uint8Array;
  recipientPublicKey: EncryptionPublicKey;
  associatedData: EncryptionAssociatedData;
}): Promise<HpkeWrappedKeyEnvelope> {
  requireByteLength(input.key, 32);
  const result = await hpkeSuite.seal(
    {
      recipientPublicKey: await importHpkePublicKey(input.recipientPublicKey),
      info: hpkeInfo,
    },
    toArrayBuffer(input.key),
    toArrayBuffer(encodeAssociatedData(input.associatedData)),
  );
  return hpkeWrappedKeyEnvelopeSchema.parse({
    version: 1,
    algorithm: "HPKE-RFC9180",
    suite: {
      mode: "base",
      kem: "DHKEM(P-256,HKDF-SHA256)",
      kdf: "HKDF-SHA256",
      aead: "AES-256-GCM",
    },
    encapsulatedKey: encodeBase64Url(new Uint8Array(result.enc)),
    ciphertext: encodeBase64Url(new Uint8Array(result.ct)),
  });
}

export async function unwrapKeyForRecipient(input: {
  envelope: HpkeWrappedKeyEnvelope;
  recipientKeyPair: CryptoKeyPair;
  associatedData: EncryptionAssociatedData;
}): Promise<Uint8Array> {
  try {
    const envelope = hpkeWrappedKeyEnvelopeSchema.parse(input.envelope);
    const plaintext = await hpkeSuite.open(
      {
        recipientKey: input.recipientKeyPair,
        enc: toArrayBuffer(decodeBase64Url(envelope.encapsulatedKey)),
        info: hpkeInfo,
      },
      toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
      toArrayBuffer(encodeAssociatedData(input.associatedData)),
    );
    const key = new Uint8Array(plaintext);
    requireByteLength(key, 32);
    return key;
  } catch {
    throw new CantripDecryptionError();
  }
}
