import {
  clearSensitiveBytes,
  encryptNativeSettingsPatch,
} from "@cantrip/crypto";
import {
  nativeSettingsBindingSchema,
  nativeSettingsUpdateContextSchema,
  nativeSettingsUpdateRequestSchema,
  nativeSettingsUpdateReceiptSchema,
  type NativeSettingsBinding,
  type NativeSettingsPatch,
  type NativeSettingsUpdateRequest,
  type NativeSettingsUpdateReceipt,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "./client-session";
import { request as apiRequest } from "./api-client";

type TrustedOptions = {
  service?: ClientEncryptionService;
  identity?: () => ClientSessionIdentitySnapshot | null;
  identityMatches?: (expected: ClientSessionIdentitySnapshot) => boolean;
};

/** Prepare once per user intent and retain this opaque request for transport
 * reconciliation. The caller supplies the stable operation identity. */
export async function prepareNativeSettingsUpdate(input: {
  chatId: string;
  binding: NativeSettingsBinding;
  patch: NativeSettingsPatch;
  operationId: string;
  options?: TrustedOptions;
}): Promise<NativeSettingsUpdateRequest> {
  const binding = nativeSettingsBindingSchema.parse(input.binding);
  if (binding.chatId !== input.chatId)
    throw new Error("Native settings belong to another chat.");
  const context = nativeSettingsUpdateContextSchema.parse({
    chatId: input.chatId,
    operationId: input.operationId,
    bindingId: binding.bindingId,
  });
  const service = input.options?.service ?? clientEncryption;
  const identity = (
    input.options?.identity ?? getClientSessionIdentitySnapshot
  )();
  const identityMatches =
    input.options?.identityMatches ?? clientSessionIdentityMatches;
  const unlocked = service.getSnapshot();
  if (
    !identity ||
    unlocked.status !== "ready" ||
    !unlocked.masterKeyRevision ||
    unlocked.identity?.ownerId !== identity.userId ||
    unlocked.identity.serverId !== identity.serverId ||
    !identityMatches(identity)
  )
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );

  const keyRevision = unlocked.masterKeyRevision;
  const componentKey = service.componentKey({
    component: "chat-content",
    identity: unlocked.identity,
    keyRevision,
  });
  try {
    const protectedPatch = await encryptNativeSettingsPatch({
      ownerId: identity.userId,
      serverId: identity.serverId,
      componentKey,
      keyRevision,
      context,
      patch: input.patch,
    });
    if (!identityMatches(identity) || service.getSnapshot() !== unlocked)
      throw new ClientEncryptionError(
        "locked",
        "The encryption session changed while preparing settings.",
      );
    return nativeSettingsUpdateRequestSchema.parse({
      operationId: context.operationId,
      bindingId: context.bindingId,
      protectedPatch,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

/** Send an existing opaque operation once. A queued receipt is not application
 * evidence; callers reconcile desired/effective state through its own reads. */
export async function sendNativeSettingsUpdate(input: {
  chatId: string;
  identity: ClientSessionIdentitySnapshot;
  request: NativeSettingsUpdateRequest;
  signal?: AbortSignal;
}): Promise<NativeSettingsUpdateReceipt> {
  const request = nativeSettingsUpdateRequestSchema.parse(input.request);
  const receipt = nativeSettingsUpdateReceiptSchema.parse(
    await apiRequest(
      `/api/chats/${encodeURIComponent(input.chatId)}/native-settings/update`,
      { method: "POST", body: JSON.stringify(request), signal: input.signal },
      { expectedIdentity: input.identity },
    ),
  );
  if (receipt.operationId !== request.operationId)
    throw new Error("Native settings response belongs to another operation.");
  return receipt;
}
