import {
  cantripOsPackageCryptoContextSchema,
  cantripOsPackagePrivateResultSchema,
  CANTRIP_OS_PACKAGE_PRIVATE_BYTES,
  type CantripOsPackageCryptoContext,
  type CantripOsPackagePrivateResult,
} from "@cantrip/protocol";
import {
  encryptionAssociatedDataSchema,
  encryptedPayloadEnvelopeSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol/encryption";
import { deriveFieldKey } from "./kdf.js";
import { clearSensitiveBytes, encodeBase64Url } from "./bytes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  encryptPayload,
  decryptPayload,
  CantripDecryptionError,
} from "./payload.js";

type Identity = {
  context: CantripOsPackageCryptoContext;
  keyRevision: number;
  componentKey: Uint8Array;
};
const limit = CANTRIP_OS_PACKAGE_PRIVATE_BYTES;
function outcome(input: Identity, raw: CantripOsPackagePrivateResult) {
  const value = cantripOsPackagePrivateResultSchema.parse(raw);
  if (
    value.request.operationId !== input.context.operationId ||
    value.request.expected.ownerId !== input.context.ownerId ||
    value.request.expected.workerId !== input.context.workerId ||
    (value.record &&
      JSON.stringify(value.record.request) !== JSON.stringify(value.request))
  )
    throw new Error("Package result admission or ownership changed");
  return value;
}
function field(input: Identity) {
  const value = cantripOsPackageCryptoContextSchema.parse(input.context);
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: value.ownerId,
    component: "repository-content",
    table: "protocol:cantrip-os-package-operations",
    field: "private_result",
    rowId: JSON.stringify([
      encodeBase64Url(sha256(new TextEncoder().encode(value.serverId))),
      value.workerId,
      value.instanceId,
      value.attachmentGeneration,
      value.targetGeneration,
      value.operationId,
    ]),
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
  return {
    associatedData,
    key: deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: value.ownerId,
      component: "repository-content",
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    }),
  };
}
export async function encryptCantripOsPackageResult(
  input: Identity & { value: CantripOsPackagePrivateResult },
) {
  const value = outcome(input, input.value);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  let key: Uint8Array | undefined;
  try {
    const material = field(input);
    key = material.key;
    if (plaintext.byteLength > limit)
      throw new Error("Private package result is too large");
    return await encryptPayload({
      key,
      associatedData: material.associatedData,
      plaintext,
    });
  } finally {
    if (key) clearSensitiveBytes(key);
    clearSensitiveBytes(plaintext);
  }
}
export async function decryptCantripOsPackageResult(
  input: Identity & { envelope: EncryptedPayloadEnvelope },
): Promise<CantripOsPackagePrivateResult> {
  let plaintext: Uint8Array | undefined;
  try {
    const envelope = encryptedPayloadEnvelopeSchema.parse(input.envelope);
    if (
      envelope.keyRevision !== input.keyRevision ||
      envelope.ciphertext.length > Math.ceil(((limit + 16) * 4) / 3)
    )
      throw new CantripDecryptionError();
    const { key, associatedData } = field(input);
    try {
      plaintext = await decryptPayload({ key, associatedData, envelope });
    } finally {
      clearSensitiveBytes(key);
    }
    if (plaintext.byteLength > limit) throw new CantripDecryptionError();
    const value = outcome(
      input,
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
    return value;
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
  }
}
