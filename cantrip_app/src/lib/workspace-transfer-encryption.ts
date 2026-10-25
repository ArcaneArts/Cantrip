import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encodeBase64Url,
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

export interface WorkspaceTransferBinding {
  serverId: string;
  ownerId: string;
  projectId: string;
  workspaceId: string;
  transferId: string;
  sourceWindowId: string;
  sourceGeneration: number;
  destinationWindowId: string;
  destinationGeneration: number;
  purpose: "ready" | "snapshot" | "restored" | "rejected";
}

function validateBinding(
  input: WorkspaceTransferBinding,
): WorkspaceTransferBinding {
  const binding = { ...input };
  const identities = [
    binding.serverId,
    binding.ownerId,
    binding.projectId,
    binding.workspaceId,
    binding.transferId,
    binding.sourceWindowId,
    binding.destinationWindowId,
  ];
  if (
    identities.some((value) => typeof value !== "string" || !value) ||
    [binding.sourceGeneration, binding.destinationGeneration].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    !["ready", "snapshot", "restored", "rejected"].includes(binding.purpose)
  )
    throw new Error("Invalid workspace transfer binding.");
  return binding;
}

const component = "surface-private-state" as const;
const table = "workspace_transfers";
const field = "endpoint_state";

async function material(
  bindingInput: WorkspaceTransferBinding,
  service: ClientEncryptionService,
  revision?: number,
) {
  const binding = validateBinding(bindingInput);
  const snapshot = service.getSnapshot();
  const account = { serverId: binding.serverId, ownerId: binding.ownerId };
  // componentKey performs the actual unlocked-account check, rather than
  // inferring availability from a cached UI or worker status.
  const keyRevision = snapshot.masterKeyRevision;
  if (!keyRevision)
    throw new Error("Workspace transfer encryption is not unlocked.");
  if (revision !== undefined && revision !== keyRevision)
    throw new Error("Workspace transfer account key revision changed.");
  const componentKey = service.componentKey({
    component,
    identity: account,
    keyRevision,
  });
  try {
    const key = deriveFieldKey({
      componentKey,
      ownerId: binding.ownerId,
      component,
      table,
      field,
      keyRevision,
    });
    try {
      // Hash the complete canonical binding to fit the shared AAD row-id limit.
      const rowId = encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify([
                binding.serverId,
                binding.ownerId,
                binding.projectId,
                binding.workspaceId,
                binding.transferId,
                binding.sourceWindowId,
                binding.sourceGeneration,
                binding.destinationWindowId,
                binding.destinationGeneration,
                binding.purpose,
              ]),
            ),
          ),
        ),
      );
      const assertCurrent = () => {
        if (service.getSnapshot() !== snapshot)
          throw new Error("Workspace transfer encryption identity changed.");
      };
      assertCurrent();
      const associatedData: EncryptionAssociatedData = {
        ownerId: binding.ownerId,
        component,
        table,
        rowId,
        field,
        keyRevision,
        formatVersion: 1,
      };
      return { key, associatedData, assertCurrent };
    } catch (error) {
      clearSensitiveBytes(key);
      throw error;
    }
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

/** Endpoint bytes only: callers validate decoded content before restoring it.
 * Never persist plaintext or place it in a workspace command/receipt. */
export async function encryptWorkspaceTransfer(
  binding: WorkspaceTransferBinding,
  plaintext: Uint8Array,
  service = clientEncryption,
): Promise<EncryptedPayloadEnvelope> {
  const captured = new Uint8Array(plaintext);
  let materialized: Awaited<ReturnType<typeof material>> | undefined;
  try {
    materialized = await material(binding, service);
    const envelope = await encryptPayload({
      ...materialized,
      plaintext: captured,
    });
    materialized.assertCurrent();
    return envelope;
  } finally {
    if (materialized) clearSensitiveBytes(materialized.key);
    clearSensitiveBytes(captured);
  }
}

export async function decryptWorkspaceTransfer(
  binding: WorkspaceTransferBinding,
  opaque: unknown,
  service = clientEncryption,
): Promise<Uint8Array> {
  const envelope = encryptedPayloadEnvelopeSchema.parse(opaque);
  const materialized = await material(binding, service, envelope.keyRevision);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptPayload({ ...materialized, envelope });
    materialized.assertCurrent();
    return plaintext;
  } catch (error) {
    if (plaintext) clearSensitiveBytes(plaintext);
    throw error;
  } finally {
    clearSensitiveBytes(materialized.key);
  }
}
