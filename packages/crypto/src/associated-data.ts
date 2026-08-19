import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

const textEncoder = new TextEncoder();

export function canonicalAssociatedData(
  input: EncryptionAssociatedData,
): string {
  const value = encryptionAssociatedDataSchema.parse(input);
  return JSON.stringify({
    component: value.component,
    field: value.field,
    formatVersion: value.formatVersion,
    keyRevision: value.keyRevision,
    ownerId: value.ownerId,
    rowId: value.rowId,
    table: value.table,
  });
}

export function encodeAssociatedData(
  input: EncryptionAssociatedData,
): Uint8Array {
  return textEncoder.encode(canonicalAssociatedData(input));
}
