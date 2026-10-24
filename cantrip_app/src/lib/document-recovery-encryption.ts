import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptedPayloadEnvelopeSchema,
  type EncryptedPayloadEnvelope,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import {
  clientEncryption,
  type ClientEncryptionService,
} from "./client-encryption";

/** Opaque resource/view identities only. Paths and document contents belong
 * inside the ciphertext. Window placement is deliberately not part of the key:
 * moving the same view must not orphan its recovery record. */
export interface DocumentRecoveryBinding {
  serverId: string;
  ownerId: string;
  workspaceId: string;
  projectId: string;
  workerId: string;
  worktreeId: string;
  documentId: string;
  tabId: string;
}

function canonicalBinding(input: DocumentRecoveryBinding): string {
  const parts = [
    input.serverId,
    input.ownerId,
    input.workspaceId,
    input.projectId,
    input.workerId,
    input.worktreeId,
    input.documentId,
    input.tabId,
  ];
  if (parts.some((part) => typeof part !== "string" || !part))
    throw new Error("Invalid document recovery binding.");
  return JSON.stringify(["cantrip-document-recovery-v1", ...parts]);
}

export async function documentRecoveryKey(
  binding: DocumentRecoveryBinding,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBinding(binding));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

const component = "surface-private-state" as const;
const table = "document_recovery";
const field = "endpoint_state";

async function material(
  input: DocumentRecoveryBinding,
  recordRevision: number,
  service: ClientEncryptionService,
  expectedKeyRevision?: number,
) {
  const binding = { ...input };
  canonicalBinding(binding);
  if (!Number.isSafeInteger(recordRevision) || recordRevision < 1)
    throw new Error("Invalid document recovery revision.");
  const snapshot = service.getSnapshot();
  const keyRevision = snapshot.masterKeyRevision;
  if (
    !keyRevision ||
    (expectedKeyRevision !== undefined && expectedKeyRevision !== keyRevision)
  )
    throw new Error(
      "Document recovery account key revision is unavailable or changed.",
    );
  const componentKey = service.componentKey({
    component,
    identity: { serverId: binding.serverId, ownerId: binding.ownerId },
    keyRevision,
  });
  let key: Uint8Array | undefined;
  try {
    key = deriveFieldKey({
      componentKey,
      ownerId: binding.ownerId,
      component,
      table,
      field,
      keyRevision,
    });
    const rowId = `${await documentRecoveryKey(binding)}:${recordRevision}`;
    const assertCurrent = () => {
      if (service.getSnapshot() !== snapshot)
        throw new Error("Document recovery encryption identity changed.");
    };
    assertCurrent();
    const associatedData: EncryptionAssociatedData = {
      ownerId: binding.ownerId,
      component,
      table,
      field,
      rowId,
      keyRevision,
      formatVersion: 1,
    };
    return { key, associatedData, assertCurrent };
  } catch (error) {
    if (key) clearSensitiveBytes(key);
    throw error;
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

/** Copy before awaiting crypto so subsequent typing cannot mutate the captured
 * checkpoint. The caller retains ownership of its original plaintext bytes. */
export async function encryptDocumentRecovery(
  binding: DocumentRecoveryBinding,
  recordRevision: number,
  plaintext: Uint8Array,
  service = clientEncryption,
): Promise<EncryptedPayloadEnvelope> {
  const captured = new Uint8Array(plaintext);
  let context: Awaited<ReturnType<typeof material>> | undefined;
  try {
    context = await material(binding, recordRevision, service);
    const envelope = await encryptPayload({ ...context, plaintext: captured });
    context.assertCurrent();
    return envelope;
  } finally {
    clearSensitiveBytes(captured);
    if (context) clearSensitiveBytes(context.key);
  }
}

/** Authenticating a record does not authorize restoring it over a newer dirty
 * document. The session owner must validate the decoded checkpoint separately. */
export async function decryptDocumentRecovery(
  binding: DocumentRecoveryBinding,
  recordRevision: number,
  opaque: unknown,
  service = clientEncryption,
): Promise<Uint8Array> {
  const envelope = encryptedPayloadEnvelopeSchema.parse(opaque);
  const context = await material(
    binding,
    recordRevision,
    service,
    envelope.keyRevision,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptPayload({ ...context, envelope });
    context.assertCurrent();
    return plaintext;
  } catch (error) {
    if (plaintext) clearSensitiveBytes(plaintext);
    throw error;
  } finally {
    clearSensitiveBytes(context.key);
  }
}
