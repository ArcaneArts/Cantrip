import {
  clearSensitiveBytes,
  decryptCantripOsSystemOperationResult,
} from "@cantrip/crypto";
import { cantripOsSystemSummarySchema } from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import { getClientSession, type ClientSessionContext } from "./client-session";
import type { CantripOsSystemSummary } from "./cantrip-os-system-draft";

export async function openCantripOsSystemResult(
  raw: CantripOsSystemSummary,
  options: {
    service?: ClientEncryptionService;
    session?: () => ClientSessionContext | null;
  } = {},
) {
  const value = cantripOsSystemSummarySchema.parse(raw),
    service = options.service ?? clientEncryption,
    session = options.session ?? getClientSession,
    current = session(),
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
      "Unlock encryption for this account to inspect private system outcomes.",
    );
  if (!value.protectedResult)
    throw new ClientEncryptionError(
      "decryption-failed",
      "No protected outcome is recorded yet. Observe the original system operation.",
    );
  const identity = snapshot.identity;
  let key: Uint8Array | undefined;
  try {
    const c = value.context;
    if (
      c.ownerId !== identity.ownerId ||
      c.serverId !== identity.serverId ||
      c.instanceId !== value.instanceId ||
      c.workerId !== value.workerId ||
      c.operationId !== value.operationId ||
      c.operationId !== value.request.operationId ||
      c.targetGeneration !== value.targetGeneration ||
      c.targetGeneration !== value.request.targetGeneration ||
      c.attachmentGeneration !== value.request.attachmentGeneration
    )
      throw new Error("The original system context changed.");
    key = service.componentKey({
      component: "repository-content",
      identity,
      keyRevision: value.protectedResult.keyRevision,
    });
    // The current maintenance fence is deliberately not substituted into AAD.
    const result = await decryptCantripOsSystemOperationResult({
      context: c,
      componentKey: key,
      keyRevision: value.protectedResult.keyRevision,
      envelope: value.protectedResult,
    });
    const command = result.command,
      request = value.request;
    if (command.action !== request.action)
      throw new Error("The private system action changed.");
    if (
      command.action === "capture" &&
      request.action === "capture" &&
      command.resumeOriginal !== request.resumeOriginal
    )
      throw new Error("The private checkpoint policy changed.");
    if (
      command.action !== "capture" &&
      request.action !== "capture" &&
      command.startTarget !== request.startTarget
    )
      throw new Error("The private system start policy changed.");
    if (
      command.action === "replace" &&
      request.action === "replace" &&
      (command.source.kind !== request.source.kind ||
        (command.source.kind === "base" &&
          request.source.kind === "base" &&
          command.source.imageId !== request.source.imageId) ||
        (command.source.kind === "checkpoint" &&
          request.source.kind === "checkpoint" &&
          command.source.capture.context.operationId !==
            request.source.operationId))
    )
      throw new Error("The private system source changed.");
    if (
      command.action === "rollback" &&
      request.action === "rollback" &&
      command.replacement.operationId !== request.replacementOperationId
    )
      throw new Error("The private rollback source changed.");
    const now = session();
    if (
      service.getSnapshot() !== snapshot ||
      now?.user.id !== identity.ownerId ||
      now.serverId !== identity.serverId
    )
      throw new Error("The account changed during system decryption.");
    return result;
  } catch {
    throw new ClientEncryptionError(
      "decryption-failed",
      "The private system outcome could not be authenticated for this account.",
    );
  } finally {
    if (key) clearSensitiveBytes(key);
  }
}
