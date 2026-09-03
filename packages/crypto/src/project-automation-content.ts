import {
  PROJECT_AUTOMATION_CONTENT_PROTECTED_BYTES_LIMIT,
  projectAutomationContentContextSchema,
  projectAutomationContentOpaqueSchema,
  type ProjectAutomationContentContext,
  type ProjectAutomationContentOpaque,
} from "@cantrip/protocol/project-automation-content";
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

// These legacy identifiers are persistent cryptographic contracts. Renaming the
// API must not make existing Project Automation ciphertext unreadable.
const component = "workflow-content" as const;
const table = "workflow:project-automation" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface Parser<T> {
  parse(value: unknown): T;
}

export function projectAutomationContentAssociatedData(input: {
  ownerId: string;
  context: ProjectAutomationContentContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = projectAutomationContentContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table,
    rowId: context.recordId,
    field: context.field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptProjectAutomationContent<T>(input: {
  ownerId: string;
  context: ProjectAutomationContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  content: T;
  schema: Parser<T>;
}): Promise<ProjectAutomationContentOpaque> {
  const content = input.schema.parse(input.content);
  const plaintext = encoder.encode(JSON.stringify(content));
  if (plaintext.byteLength > PROJECT_AUTOMATION_CONTENT_PROTECTED_BYTES_LIMIT) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected project automation content is too large.");
  }
  const associatedData = projectAutomationContentAssociatedData(input);
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    return projectAutomationContentOpaqueSchema.parse({
      formatVersion,
      keyRevision: input.keyRevision,
      envelope: await encryptPayload({
        key: fieldKey,
        plaintext,
        associatedData,
      }),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptProjectAutomationContent<T>(input: {
  ownerId: string;
  context: ProjectAutomationContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: ProjectAutomationContentOpaque;
  schema: Parser<T>;
}): Promise<T> {
  let plaintext: Uint8Array | null = null;
  let fieldKey: Uint8Array | null = null;
  try {
    const encrypted = projectAutomationContentOpaqueSchema.parse(
      input.encrypted,
    );
    if (
      encrypted.formatVersion !== formatVersion ||
      encrypted.keyRevision !== input.keyRevision ||
      encrypted.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
    const associatedData = projectAutomationContentAssociatedData(input);
    fieldKey = deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component,
      table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    });
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: encrypted.envelope,
      associatedData,
    });
    if (
      plaintext.byteLength > PROJECT_AUTOMATION_CONTENT_PROTECTED_BYTES_LIMIT
    ) {
      throw new CantripDecryptionError();
    }
    return input.schema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    if (fieldKey) clearSensitiveBytes(fieldKey);
  }
}
