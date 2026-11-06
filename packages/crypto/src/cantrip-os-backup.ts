import {
  CANTRIP_OS_BACKUP_CHUNK_BYTES,
  CANTRIP_OS_BACKUP_METADATA_BYTES,
  CANTRIP_OS_BACKUP_END_BYTES,
  cantripOsBackupCryptoContextSchema,
  cantripOsBackupFrameSchema,
  type CantripOsBackupCryptoContext,
  type CantripOsBackupFrame,
} from "@cantrip/protocol/cantrip-os-backup";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { sha256 } from "@noble/hashes/sha2.js";
import { clearSensitiveBytes, encodeBase64Url } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "repository-content" as const;
type Kind = CantripOsBackupFrame["kind"];
type Identity = {
  context: CantripOsBackupCryptoContext;
  keyRevision: number;
  componentKey: Uint8Array;
};

function limit(kind: Kind) {
  return kind === "chunk"
    ? CANTRIP_OS_BACKUP_CHUNK_BYTES
    : kind === "metadata"
      ? CANTRIP_OS_BACKUP_METADATA_BYTES
      : CANTRIP_OS_BACKUP_END_BYTES;
}

export function cantripOsBackupAssociatedData(input: {
  context: CantripOsBackupCryptoContext;
  keyRevision: number;
  kind: Kind;
  sequence: number;
}): EncryptionAssociatedData {
  const context = cantripOsBackupCryptoContextSchema.parse(input.context);
  const kind = cantripOsBackupFrameSchema.shape.kind.parse(input.kind);
  const sequence = cantripOsBackupFrameSchema.shape.sequence.parse(
    input.sequence,
  );
  return encryptionAssociatedDataSchema.parse({
    ownerId: context.ownerId,
    component,
    table: "protocol:cantrip-os-private-backup",
    field: `private_backup_${kind}`,
    rowId: JSON.stringify([
      encodeBase64Url(sha256(new TextEncoder().encode(context.serverId))),
      context.backupId,
      kind,
      sequence,
    ]),
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
}

function fieldKey(input: Identity, associatedData: EncryptionAssociatedData) {
  return deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: associatedData.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
}

export async function encryptCantripOsBackupFrame(
  input: Identity & {
    kind: Kind;
    sequence: number;
    plaintext: Uint8Array;
  },
): Promise<CantripOsBackupFrame> {
  const associatedData = cantripOsBackupAssociatedData(input);
  if (input.plaintext.byteLength > limit(input.kind))
    throw new Error("Private backup frame is too large.");
  const key = fieldKey(input, associatedData);
  try {
    return {
      kind: input.kind,
      sequence: input.sequence,
      envelope: await encryptPayload({
        key,
        plaintext: input.plaintext,
        associatedData,
      }),
    };
  } finally {
    clearSensitiveBytes(key);
  }
}

export async function decryptCantripOsBackupFrame(
  input: Identity & {
    frame: CantripOsBackupFrame;
  },
): Promise<Uint8Array> {
  try {
    const frame = cantripOsBackupFrameSchema.parse(input.frame);
    if (
      frame.envelope.keyRevision !== input.keyRevision ||
      frame.envelope.ciphertext.length >
        Math.ceil((limit(frame.kind) + 16) / 3) * 4
    )
      throw new CantripDecryptionError();
    const associatedData = cantripOsBackupAssociatedData({
      ...input,
      kind: frame.kind,
      sequence: frame.sequence,
    });
    const key = fieldKey(input, associatedData);
    try {
      const plaintext = await decryptPayload({
        key,
        envelope: frame.envelope,
        associatedData,
      });
      if (plaintext.byteLength > limit(frame.kind)) {
        clearSensitiveBytes(plaintext);
        throw new CantripDecryptionError();
      }
      return plaintext;
    } finally {
      clearSensitiveBytes(key);
    }
  } catch {
    throw new CantripDecryptionError();
  }
}
