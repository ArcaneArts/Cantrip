import {
  encryptionComponentScopeSchema,
  encryptionKeyRevisionSchema,
  passwordKdfParametersSchema,
  type EncryptionComponentScope,
  type PasswordKdfParameters,
} from "@cantrip/protocol/encryption";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  clearSensitiveBytes,
  decodeBase64Url,
  encodeBase64Url,
  randomBytes,
  requireByteLength,
} from "./bytes.js";

const textEncoder = new TextEncoder();
const PASSWORD_KDF_CONTEXT = "cantrip:e2ee:password-kek:v1" as const;

function boundedLabel(value: string, label: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum) {
    throw new Error(`${label} length is out of range.`);
  }
  return value;
}

function hkdfSalt(ownerId: string): Uint8Array {
  return sha256(
    textEncoder.encode(
      `cantrip:e2ee:hkdf-salt:v1\u0000${boundedLabel(ownerId, "Owner ID", 255)}`,
    ),
  );
}

function hkdfInfo(domain: string, fields: readonly (string | number)[]) {
  return textEncoder.encode(JSON.stringify([domain, ...fields]));
}

function deriveKey(
  sourceKey: Uint8Array,
  ownerId: string,
  domain: string,
  fields: readonly (string | number)[],
): Uint8Array {
  requireByteLength(sourceKey, 32);
  return hkdf(
    sha256,
    sourceKey,
    hkdfSalt(ownerId),
    hkdfInfo(domain, fields),
    32,
  );
}

export function createPasswordKdfParameters(
  overrides: Partial<
    Pick<PasswordKdfParameters, "memoryKiB" | "iterations" | "parallelism">
  > = {},
): PasswordKdfParameters {
  return passwordKdfParametersSchema.parse({
    algorithm: "Argon2id",
    version: 19,
    context: PASSWORD_KDF_CONTEXT,
    memoryKiB: overrides.memoryKiB ?? 65_536,
    iterations: overrides.iterations ?? 3,
    parallelism: overrides.parallelism ?? 1,
    outputBytes: 32,
    salt: encodeBase64Url(randomBytes(32)),
  });
}

export async function derivePasswordKey(
  password: string,
  input: PasswordKdfParameters,
): Promise<Uint8Array> {
  const parameters = passwordKdfParametersSchema.parse(input);
  const passwordBytes = textEncoder.encode(password);
  const salt = decodeBase64Url(parameters.salt);
  try {
    return await argon2idAsync(passwordBytes, salt, {
      asyncTick: 8,
      dkLen: parameters.outputBytes,
      m: parameters.memoryKiB,
      p: parameters.parallelism,
      personalization: textEncoder.encode(parameters.context),
      t: parameters.iterations,
      version: parameters.version,
    });
  } finally {
    clearSensitiveBytes(passwordBytes);
    clearSensitiveBytes(salt);
  }
}

export function deriveComponentKey(input: {
  accountMasterKey: Uint8Array;
  ownerId: string;
  component: EncryptionComponentScope;
  keyRevision: number;
}): Uint8Array {
  const component = encryptionComponentScopeSchema.parse(input.component);
  const revision = encryptionKeyRevisionSchema.parse(input.keyRevision);
  return deriveKey(
    input.accountMasterKey,
    input.ownerId,
    "cantrip:e2ee:component-key:v1",
    [component, revision],
  );
}

export function deriveFieldKey(input: {
  componentKey: Uint8Array;
  ownerId: string;
  component: EncryptionComponentScope;
  table: string;
  field: string;
  keyRevision: number;
}): Uint8Array {
  const component = encryptionComponentScopeSchema.parse(input.component);
  const revision = encryptionKeyRevisionSchema.parse(input.keyRevision);
  return deriveKey(
    input.componentKey,
    input.ownerId,
    "cantrip:e2ee:field-key:v1",
    [
      component,
      boundedLabel(input.table, "Table", 120),
      boundedLabel(input.field, "Field", 120),
      revision,
    ],
  );
}

export function deriveLookupKey(input: {
  componentKey: Uint8Array;
  ownerId: string;
  component: EncryptionComponentScope;
  table: string;
  field: string;
  keyRevision: number;
}): Uint8Array {
  const component = encryptionComponentScopeSchema.parse(input.component);
  const revision = encryptionKeyRevisionSchema.parse(input.keyRevision);
  return deriveKey(
    input.componentKey,
    input.ownerId,
    "cantrip:e2ee:lookup-key:v1",
    [
      component,
      boundedLabel(input.table, "Table", 120),
      boundedLabel(input.field, "Field", 120),
      revision,
    ],
  );
}

export function computeBlindLookupTag(
  lookupKey: Uint8Array,
  canonicalValue: string,
): string {
  requireByteLength(lookupKey, 32, "Lookup key");
  return encodeBase64Url(
    hmac(sha256, lookupKey, textEncoder.encode(canonicalValue)),
  );
}
