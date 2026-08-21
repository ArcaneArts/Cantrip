import {
  WORKFLOW_CONTENT_PROTECTED_BYTES_LIMIT,
  workflowContentContextSchema,
  workflowContentOpaqueSchema,
  type WorkflowContentContext,
  type WorkflowContentOpaque,
} from "@cantrip/protocol/workflow-content";
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

const component = "workflow-content" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface Parser<T> {
  parse(value: unknown): T;
}

function tableFor(recordKind: WorkflowContentContext["recordKind"]): string {
  return `workflow:${recordKind}`;
}

export function workflowContentAssociatedData(input: {
  ownerId: string;
  context: WorkflowContentContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = workflowContentContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: tableFor(context.recordKind),
    rowId: context.recordId,
    field: context.field,
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptWorkflowContent<T>(input: {
  ownerId: string;
  context: WorkflowContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  content: T;
  schema: Parser<T>;
}): Promise<WorkflowContentOpaque> {
  const content = input.schema.parse(input.content);
  const plaintext = encoder.encode(JSON.stringify(content));
  if (plaintext.byteLength > WORKFLOW_CONTENT_PROTECTED_BYTES_LIMIT) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected workflow content is too large.");
  }
  const associatedData = workflowContentAssociatedData(input);
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    return workflowContentOpaqueSchema.parse({
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

export async function decryptWorkflowContent<T>(input: {
  ownerId: string;
  context: WorkflowContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: WorkflowContentOpaque;
  schema: Parser<T>;
}): Promise<T> {
  let plaintext: Uint8Array | null = null;
  let fieldKey: Uint8Array | null = null;
  try {
    const encrypted = workflowContentOpaqueSchema.parse(input.encrypted);
    if (
      encrypted.formatVersion !== formatVersion ||
      encrypted.keyRevision !== input.keyRevision ||
      encrypted.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
    const associatedData = workflowContentAssociatedData(input);
    fieldKey = deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    });
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: encrypted.envelope,
      associatedData,
    });
    if (plaintext.byteLength > WORKFLOW_CONTENT_PROTECTED_BYTES_LIMIT) {
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
