import {
  PROTECTED_SECRET_BYTES_LIMIT,
  protectedSecretEnvelopeSchema,
  type ProtectedSecretEnvelope,
} from "@cantrip/protocol/protected-secrets";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
  type EncryptionComponentScope,
} from "@cantrip/protocol/encryption";

import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

interface Parser<T> {
  parse(value: unknown): T;
}

function associatedData(input: {
  ownerId: string;
  component: Extract<
    EncryptionComponentScope,
    "provider-credential" | "mcp-secret" | "run-content"
  >;
  table:
    | "model_providers"
    | "model_provider_accounts"
    | "mcp_servers"
    | "run_configuration_secrets";
  rowId: string;
  field:
    | "protected_api_key"
    | "protected_credential"
    | "protected_configuration"
    | "protected_label"
    | "protected_value";
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ...input,
    formatVersion: 1,
  });
}

export async function encryptProtectedSecret<T>(input: {
  ownerId: string;
  component: Extract<
    EncryptionComponentScope,
    "provider-credential" | "mcp-secret" | "run-content"
  >;
  table:
    | "model_providers"
    | "model_provider_accounts"
    | "mcp_servers"
    | "run_configuration_secrets";
  rowId: string;
  field:
    | "protected_api_key"
    | "protected_credential"
    | "protected_configuration"
    | "protected_label"
    | "protected_value";
  keyRevision: number;
  componentKey: Uint8Array;
  content: T;
  contentSchema: Parser<T>;
  maximumBytes?: number;
}): Promise<ProtectedSecretEnvelope> {
  const aad = associatedData({
    ownerId: input.ownerId,
    component: input.component,
    table: input.table,
    rowId: input.rowId,
    field: input.field,
    keyRevision: input.keyRevision,
  });
  const plaintext = encoder.encode(
    JSON.stringify(input.contentSchema.parse(input.content)),
  );
  const maximumBytes = input.maximumBytes ?? PROTECTED_SECRET_BYTES_LIMIT;
  if (plaintext.byteLength > maximumBytes) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected secret exceeds its byte limit.");
  }
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: input.component,
    table: input.table,
    field: input.field,
    keyRevision: input.keyRevision,
  });
  try {
    return protectedSecretEnvelopeSchema.parse({
      formatVersion: 1,
      keyRevision: input.keyRevision,
      envelope: await encryptPayload({
        key: fieldKey,
        plaintext,
        associatedData: aad,
      }),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptProtectedSecret<T>(input: {
  ownerId: string;
  component: Extract<
    EncryptionComponentScope,
    "provider-credential" | "mcp-secret" | "run-content"
  >;
  table:
    | "model_providers"
    | "model_provider_accounts"
    | "mcp_servers"
    | "run_configuration_secrets";
  rowId: string;
  field:
    | "protected_api_key"
    | "protected_credential"
    | "protected_configuration"
    | "protected_label"
    | "protected_value";
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: ProtectedSecretEnvelope;
  contentSchema: Parser<T>;
  maximumBytes?: number;
}): Promise<T> {
  const encrypted = protectedSecretEnvelopeSchema.parse(input.encrypted);
  if (encrypted.keyRevision !== input.keyRevision) {
    throw new CantripDecryptionError();
  }
  const aad = associatedData({
    ownerId: input.ownerId,
    component: input.component,
    table: input.table,
    rowId: input.rowId,
    field: input.field,
    keyRevision: input.keyRevision,
  });
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: input.component,
    table: input.table,
    field: input.field,
    keyRevision: input.keyRevision,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key: fieldKey,
      envelope: encrypted.envelope,
      associatedData: aad,
    });
    if (
      plaintext.byteLength >
      (input.maximumBytes ?? PROTECTED_SECRET_BYTES_LIMIT)
    ) {
      throw new CantripDecryptionError();
    }
    return input.contentSchema.parse(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(fieldKey);
  }
}
