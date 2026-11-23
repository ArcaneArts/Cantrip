import {
  CANTRIP_OS_SYSTEM_CHUNK_BYTES,
  CANTRIP_OS_SYSTEM_METADATA_BYTES,
  CANTRIP_OS_SYSTEM_END_BYTES,
  cantripOsSystemCryptoContextSchema,
  cantripOsSystemFileHeaderSchema,
  cantripOsSystemFrameSchema,
  type CantripOsSystemCryptoContext,
  type CantripOsSystemFrame,
} from "@cantrip/protocol/cantrip-os-system";
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

type Identity = {
  context: CantripOsSystemCryptoContext;
  streamId: string;
  keyRevision: number;
  componentKey: Uint8Array;
};
type Kind = CantripOsSystemFrame["kind"];
const component = "repository-content" as const;
function limit(kind: Kind) {
  return kind === "chunk"
    ? CANTRIP_OS_SYSTEM_CHUNK_BYTES
    : kind === "end"
      ? CANTRIP_OS_SYSTEM_END_BYTES
      : CANTRIP_OS_SYSTEM_METADATA_BYTES;
}
export function cantripOsSystemAssociatedData(
  input: Omit<Identity, "componentKey"> & {
    kind: Kind;
    sequence: number;
  },
): EncryptionAssociatedData {
  const c = cantripOsSystemCryptoContextSchema.parse(input.context);
  const stream = cantripOsSystemFileHeaderSchema.shape.streamId.parse(
    input.streamId,
  );
  const kind = cantripOsSystemFrameSchema.shape.kind.parse(input.kind);
  const sequence = cantripOsSystemFrameSchema.shape.sequence.parse(
    input.sequence,
  );
  return encryptionAssociatedDataSchema.parse({
    ownerId: c.ownerId,
    component,
    table: "protocol:cantrip-os-private-system",
    field: `private_system_${kind}`,
    rowId: JSON.stringify([
      encodeBase64Url(
        sha256(
          new TextEncoder().encode(
            JSON.stringify([
              c.serverId,
              c.workerId,
              c.instanceId,
              c.guestInstanceId,
              c.attachmentGeneration,
              c.targetGeneration,
              c.operationId,
              c.checkpointId,
              c.containerId,
              stream,
            ]),
          ),
        ),
      ),
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
export async function encryptCantripOsSystemFrame(
  input: Identity & {
    kind: Kind;
    sequence: number;
    plaintext: Uint8Array;
  },
): Promise<CantripOsSystemFrame> {
  const associatedData = cantripOsSystemAssociatedData(input);
  if (input.plaintext.byteLength > limit(input.kind))
    throw new Error("Private system frame is too large.");
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
export async function decryptCantripOsSystemFrame(
  input: Identity & {
    frame: CantripOsSystemFrame;
  },
): Promise<Uint8Array> {
  try {
    const frame = cantripOsSystemFrameSchema.parse(input.frame);
    if (
      frame.envelope.keyRevision !== input.keyRevision ||
      frame.envelope.ciphertext.length >
        Math.ceil((limit(frame.kind) + 16) / 3) * 4
    )
      throw new CantripDecryptionError();
    const associatedData = cantripOsSystemAssociatedData({
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
