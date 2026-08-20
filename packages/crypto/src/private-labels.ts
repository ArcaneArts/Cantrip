import {
  PRIVATE_DISPLAY_LABEL_PROTECTED_CONTENT_BYTES_LIMIT,
  privateDisplayLabelOpaqueSchema,
  privateDisplayLabelProtectedContentSchema,
  type PrivateDisplayLabelOpaque,
  type PrivateDisplayLabelRecordKind,
} from "@cantrip/protocol/private-labels";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";

import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "private-surface-metadata" as const;
const formatVersion = 1 as const;
const field = "protected_label";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const privateDisplayLabelTables = {
  project: "projects",
  chat: "chats",
  terminal: "terminals",
  explorer: "explorers",
  "code-tab": "code_tabs",
  browser: "browsers",
  "remote-surface": "remote_surfaces",
  "project-view": "project_views",
  "tab-group": "tab_groups",
} as const satisfies Record<PrivateDisplayLabelRecordKind, string>;

export function privateDisplayLabelAssociatedData(input: {
  ownerId: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: privateDisplayLabelTables[input.recordKind],
    rowId: input.rowId,
    field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptPrivateDisplayLabel(input: {
  ownerId: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  label: string;
}): Promise<PrivateDisplayLabelOpaque> {
  const content = privateDisplayLabelProtectedContentSchema.parse({
    version: formatVersion,
    classification: { recordKind: input.recordKind },
    label: input.label,
  });
  const plaintext = encoder.encode(JSON.stringify(content));
  if (
    plaintext.byteLength > PRIVATE_DISPLAY_LABEL_PROTECTED_CONTENT_BYTES_LIMIT
  ) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected display label exceeds its encoded byte limit.");
  }
  const associatedData = privateDisplayLabelAssociatedData(input);
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    return privateDisplayLabelOpaqueSchema.parse({
      classification: content.classification,
      protectedLabel: {
        formatVersion,
        keyRevision: input.keyRevision,
        envelope: await encryptPayload({
          key: fieldKey,
          plaintext,
          associatedData,
        }),
      },
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptPrivateDisplayLabel(input: {
  ownerId: string;
  recordKind: PrivateDisplayLabelRecordKind;
  rowId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  opaque: PrivateDisplayLabelOpaque;
}): Promise<string> {
  let opaque: PrivateDisplayLabelOpaque;
  try {
    opaque = privateDisplayLabelOpaqueSchema.parse(input.opaque);
    if (
      opaque.protectedLabel.keyRevision !== input.keyRevision ||
      opaque.classification.recordKind !== input.recordKind
    ) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const associatedData = privateDisplayLabelAssociatedData(input);
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: opaque.protectedLabel.envelope,
      associatedData,
    });
    if (
      plaintext.byteLength > PRIVATE_DISPLAY_LABEL_PROTECTED_CONTENT_BYTES_LIMIT
    ) {
      throw new CantripDecryptionError();
    }
    const content = privateDisplayLabelProtectedContentSchema.parse(
      JSON.parse(decoder.decode(plaintext)),
    );
    if (
      content.classification.recordKind !== opaque.classification.recordKind
    ) {
      throw new CantripDecryptionError();
    }
    return content.label;
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(fieldKey);
  }
}
