import {
  cantripOsBackupRequestEnvelopeSchema,
  cantripOsBackupResponseEnvelopeSchema,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import type { CantripOsBackupFrame } from "@cantrip/protocol/cantrip-os-backup";
import {
  decryptCantripOsBackupFrame,
  encryptCantripOsBackupFrame,
} from "./cantrip-os-backup.js";
import { CantripDecryptionError } from "./payload.js";

type Identity = {
  ownerId: string;
  serverId: string;
  operationId: string;
  keyRevision: number;
  componentKey: Uint8Array;
};

/** Metadata position zero belongs to the file; positions one/two belong to the
 * admitted operation request/response. AAD prevents exchanging these messages. */
export async function encryptCantripOsBackupMessage(
  input: Identity & {
    direction: "request" | "response";
    plaintext: Uint8Array;
  },
) {
  const schema =
    input.direction === "request"
      ? cantripOsBackupRequestEnvelopeSchema
      : cantripOsBackupResponseEnvelopeSchema;
  return schema.parse(
    await encryptCantripOsBackupFrame({
      context: {
        ownerId: input.ownerId,
        serverId: input.serverId,
        backupId: input.operationId,
      },
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      kind: "metadata",
      sequence: input.direction === "request" ? 1 : 2,
      plaintext: input.plaintext,
    }),
  );
}

export async function decryptCantripOsBackupMessage(
  input: Identity & {
    direction: "request" | "response";
    frame: CantripOsBackupFrame;
  },
) {
  try {
    const schema =
      input.direction === "request"
        ? cantripOsBackupRequestEnvelopeSchema
        : cantripOsBackupResponseEnvelopeSchema;
    const frame = schema.parse(input.frame);
    return await decryptCantripOsBackupFrame({
      context: {
        ownerId: input.ownerId,
        serverId: input.serverId,
        backupId: input.operationId,
      },
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      frame,
    });
  } catch {
    throw new CantripDecryptionError();
  }
}
