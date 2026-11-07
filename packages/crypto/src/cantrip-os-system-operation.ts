import {
  CANTRIP_OS_SYSTEM_RESULT_BYTES,
  cantripOsSystemOperationContextSchema,
  cantripOsSystemPrivateOperationResultSchema,
  cantripOsSystemProtectedOperationResultSchema,
  type CantripOsSystemOperationContext,
  type CantripOsSystemPrivateOperationResult,
} from "@cantrip/protocol";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
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
  context: CantripOsSystemOperationContext;
  componentKey: Uint8Array;
  keyRevision: number;
};
function material(input: Identity) {
  const c = cantripOsSystemOperationContextSchema.parse(input.context);
  const ad = encryptionAssociatedDataSchema.parse({
    ownerId: c.ownerId,
    component: "repository-content",
    table: "protocol:cantrip-os-system-operations",
    field: "private_result",
    formatVersion: 1,
    keyRevision: input.keyRevision,
    rowId: encodeBase64Url(
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
            c.containerId,
          ]),
        ),
      ),
    ),
  });
  return {
    ad,
    key: deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: c.ownerId,
      component: "repository-content",
      table: ad.table,
      field: ad.field,
      keyRevision: input.keyRevision,
    }),
  };
}
function outcome(input: Identity, raw: unknown) {
  const value = cantripOsSystemPrivateOperationResultSchema.parse(raw),
    command = value.command,
    c = input.context;
  if (
    command.operationId !== c.operationId ||
    command.target.generation !== c.targetGeneration ||
    command.target.containerId !== c.containerId ||
    Object.entries(command.scope).some(([k, v]) => v !== c[k as keyof typeof c])
  )
    throw new Error("The private system result belongs to another admission");
  return value;
}
export async function encryptCantripOsSystemOperationResult(
  input: Identity & { value: CantripOsSystemPrivateOperationResult },
) {
  const value = outcome(input, input.value),
    plaintext = new TextEncoder().encode(JSON.stringify(value));
  let key: Uint8Array | undefined;
  try {
    if (plaintext.length > CANTRIP_OS_SYSTEM_RESULT_BYTES)
      throw new Error("Private system outcome is too large");
    const derived = material(input);
    key = derived.key;
    return await encryptPayload({ key, plaintext, associatedData: derived.ad });
  } finally {
    if (key) clearSensitiveBytes(key);
    clearSensitiveBytes(plaintext);
  }
}
export async function decryptCantripOsSystemOperationResult(
  input: Identity & { envelope: EncryptedPayloadEnvelope },
): Promise<CantripOsSystemPrivateOperationResult> {
  let key: Uint8Array | undefined, plaintext: Uint8Array | undefined;
  try {
    const envelope = cantripOsSystemProtectedOperationResultSchema.parse(
      input.envelope,
    );
    if (envelope.keyRevision !== input.keyRevision)
      throw new CantripDecryptionError();
    const derived = material(input);
    key = derived.key;
    plaintext = await decryptPayload({
      key,
      envelope,
      associatedData: derived.ad,
    });
    if (plaintext.length > CANTRIP_OS_SYSTEM_RESULT_BYTES)
      throw new CantripDecryptionError();
    return outcome(
      input,
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (key) clearSensitiveBytes(key);
    if (plaintext) clearSensitiveBytes(plaintext);
  }
}
