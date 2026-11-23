import {
  clearSensitiveBytes,
  decryptCantripOsPackageResult,
} from "@cantrip/crypto";
import {
  cantripOsPackageSummarySchema,
  type CantripOsPackageSummary,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import { getClientSession, type ClientSessionContext } from "./client-session";

export async function openCantripOsPackageResult(
  raw: CantripOsPackageSummary,
  options: {
    service?: ClientEncryptionService;
    session?: () => ClientSessionContext | null;
  } = {},
) {
  const value = cantripOsPackageSummarySchema.parse(raw);
  const service = options.service ?? clientEncryption,
    session = options.session ?? getClientSession;
  const current = session(),
    snapshot = service.getSnapshot();
  if (
    !current ||
    snapshot.status !== "ready" ||
    !snapshot.identity ||
    !snapshot.masterKeyRevision ||
    snapshot.identity.ownerId !== current.user.id ||
    snapshot.identity.serverId !== current.serverId
  )
    throw new ClientEncryptionError(
      "locked",
      "Unlock encryption for this account to inspect private package outcomes.",
    );
  const identity = snapshot.identity;
  if (!value.protectedResult)
    throw new ClientEncryptionError(
      "decryption-failed",
      "No protected outcome is recorded yet. Observe the original package operation.",
    );
  let key: Uint8Array | undefined;
  try {
    key = service.componentKey({
      component: "repository-content",
      identity,
      keyRevision: value.protectedResult.keyRevision,
    });
    const result = await decryptCantripOsPackageResult({
      componentKey: key,
      keyRevision: value.protectedResult.keyRevision,
      context: {
        ownerId: identity.ownerId,
        serverId: identity.serverId,
        workerId: value.workerId,
        instanceId: value.instanceId,
        attachmentGeneration: value.attachmentGeneration,
        targetGeneration: value.targetGeneration,
        operationId: value.operationId,
      },
      envelope: value.protectedResult,
    });
    const now = session();
    if (
      service.getSnapshot() !== snapshot ||
      now?.user.id !== identity.ownerId ||
      now.serverId !== identity.serverId
    )
      throw new Error("The account changed during package decryption.");
    if (
      result.request.action !== value.action ||
      result.request.configuration !== value.configuration ||
      JSON.stringify(result.request.packages) !== JSON.stringify(value.packages)
    )
      throw new Error("The private package outcome changed its admission.");
    return result;
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "The private package outcome could not be authenticated for this account.",
    );
  } finally {
    if (key) clearSensitiveBytes(key);
  }
}
