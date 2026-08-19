import { argon2id } from "@noble/hashes/argon2.js";
import { describe, expect, it } from "vitest";

import {
  CantripDecryptionError,
  canonicalAssociatedData,
  clearSensitiveBytes,
  computeBlindLookupTag,
  createPasswordKdfParameters,
  decodeBase64Url,
  deriveComponentKey,
  deriveFieldKey,
  deriveLookupKey,
  derivePasswordKey,
  encodeBase64Url,
  encryptPayload,
  decryptPayload,
  exportHpkePublicKey,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  randomBytes,
  unwrapAccountMasterKeyWithPassword,
  unwrapKeyForRecipient,
  wrapAccountMasterKeyWithPassword,
  wrapKeyForRecipient,
} from "../src/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const associatedData = {
  ownerId: "owner-1",
  component: "workspace-display-name",
  table: "project_workspaces",
  rowId: "workspace-1",
  field: "name",
  formatVersion: 1,
  keyRevision: 1,
} as const;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function tamper(value: string): string {
  const bytes = decodeBase64Url(value);
  bytes[0] ^= 1;
  return encodeBase64Url(bytes);
}

describe("Cantrip encryption primitives", () => {
  it("matches the RFC 9106 Argon2id v1.3 test vector", () => {
    const tag = argon2id(
      new Uint8Array(32).fill(1),
      new Uint8Array(16).fill(2),
      {
        t: 3,
        m: 32,
        p: 4,
        dkLen: 32,
        version: 19,
        key: new Uint8Array(8).fill(3),
        personalization: new Uint8Array(12).fill(4),
      },
    );
    expect(toHex(tag)).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });

  it("uses canonical encoding and associated data", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
    expect(() => decodeBase64Url("AA==")).toThrow(/canonical/iu);
    expect(canonicalAssociatedData(associatedData)).toBe(
      '{"component":"workspace-display-name","field":"name","formatVersion":1,"keyRevision":1,"ownerId":"owner-1","rowId":"workspace-1","table":"project_workspaces"}',
    );
  });

  it("derives independent component, field, and lookup keys", () => {
    const accountMasterKey = new Uint8Array(32).fill(7);
    const componentKey = deriveComponentKey({
      accountMasterKey,
      ownerId: associatedData.ownerId,
      component: associatedData.component,
      keyRevision: 1,
    });
    const fieldKey = deriveFieldKey({
      componentKey,
      ownerId: associatedData.ownerId,
      component: associatedData.component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: 1,
    });
    const lookupKey = deriveLookupKey({
      componentKey,
      ownerId: associatedData.ownerId,
      component: associatedData.component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: 1,
    });
    expect(fieldKey).not.toEqual(componentKey);
    expect(lookupKey).not.toEqual(fieldKey);
    expect(computeBlindLookupTag(lookupKey, "default")).toHaveLength(43);
  });

  it("round-trips payloads and rejects wrong keys, tampering, and changed AAD", async () => {
    const key = randomBytes(32);
    const envelope = await encryptPayload({
      key,
      plaintext: textEncoder.encode("Workspace name"),
      associatedData,
    });
    await expect(
      decryptPayload({ key, envelope, associatedData }),
    ).resolves.toSatisfy(
      (value: Uint8Array) => textDecoder.decode(value) === "Workspace name",
    );
    await expect(
      decryptPayload({ key: randomBytes(32), envelope, associatedData }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPayload({
        key,
        envelope: { ...envelope, ciphertext: tamper(envelope.ciphertext) },
        associatedData,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      decryptPayload({
        key,
        envelope,
        associatedData: { ...associatedData, rowId: "workspace-2" },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });

  it("round-trips a password wrapper with a KDF context independent from authentication", async () => {
    const kdf = createPasswordKdfParameters({
      memoryKiB: 8_192,
      iterations: 1,
      parallelism: 1,
    });
    const encryptionKey = await derivePasswordKey("correct horse", kdf);
    const authenticationContextKey = argon2id(
      textEncoder.encode("correct horse"),
      decodeBase64Url(kdf.salt),
      {
        t: kdf.iterations,
        m: kdf.memoryKiB,
        p: kdf.parallelism,
        dkLen: kdf.outputBytes,
        version: kdf.version,
        personalization: textEncoder.encode("cantrip:authentication:v1"),
      },
    );
    expect(encryptionKey).not.toEqual(authenticationContextKey);

    const accountMasterKey = generateAccountMasterKey();
    const wrapper = await wrapAccountMasterKeyWithPassword({
      password: "correct horse",
      ownerId: "owner-1",
      accountMasterKey,
      masterKeyRevision: 1,
      kdf,
    });
    await expect(
      unwrapAccountMasterKeyWithPassword({
        password: "correct horse",
        ownerId: "owner-1",
        wrapper,
      }),
    ).resolves.toEqual(accountMasterKey);
    await expect(
      unwrapAccountMasterKeyWithPassword({
        password: "wrong horse",
        ownerId: "owner-1",
        wrapper,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    clearSensitiveBytes(encryptionKey);
    clearSensitiveBytes(authenticationContextKey);
    clearSensitiveBytes(accountMasterKey);
  });

  it("round-trips HPKE key wrappers and rejects wrong recipients, tampering, and changed AAD", async () => {
    const recipient = await generateHpkeKeyPair();
    const wrongRecipient = await generateHpkeKeyPair();
    expect(recipient.privateKey.extractable).toBe(false);
    const recipientPublicKey = await exportHpkePublicKey(recipient.publicKey);
    const key = randomBytes(32);
    const envelope = await wrapKeyForRecipient({
      key,
      recipientPublicKey,
      associatedData,
    });
    await expect(
      unwrapKeyForRecipient({
        envelope,
        recipientKeyPair: recipient,
        associatedData,
      }),
    ).resolves.toEqual(key);
    await expect(
      unwrapKeyForRecipient({
        envelope,
        recipientKeyPair: wrongRecipient,
        associatedData,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      unwrapKeyForRecipient({
        envelope: { ...envelope, ciphertext: tamper(envelope.ciphertext) },
        recipientKeyPair: recipient,
        associatedData,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      unwrapKeyForRecipient({
        envelope,
        recipientKeyPair: recipient,
        associatedData: { ...associatedData, ownerId: "owner-2" },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
