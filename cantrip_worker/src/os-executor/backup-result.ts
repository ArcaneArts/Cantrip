import {
  clearSensitiveBytes,
  encryptCantripOsBackupMessage,
} from "@cantrip/crypto";
import type { CantripOsDispatchScope } from "@cantrip/protocol";
import {
  cantripOsBackupPrivateResultSchema,
  cantripOsBackupResponseEnvelopeSchema,
  type CantripOsBackupPrivateResult,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import type { BackupKeyAccess } from "./private-backup-file.js";

/** Actual failure messages can contain private paths. Return them only through
 * the same account-protected response channel as successful backup receipts. */
export async function protectBackupResult(
  keys: BackupKeyAccess,
  scope: CantripOsDispatchScope,
  operationId: string,
  value: CantripOsBackupPrivateResult,
) {
  if (
    keys.ownerId() !== scope.ownerId ||
    keys.serverIdentity() !== scope.serverId
  )
    throw new Error("The backup account or logical Server changed.");
  const result = cantripOsBackupPrivateResultSchema.parse(value);
  const material = keys.componentKey("repository-content");
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new TextEncoder().encode(JSON.stringify(result));
    return cantripOsBackupResponseEnvelopeSchema.parse(
      await encryptCantripOsBackupMessage({
        ...scope,
        operationId,
        keyRevision: material.keyRevision,
        componentKey: material.key,
        direction: "response",
        plaintext,
      }),
    );
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(material.key);
  }
}
