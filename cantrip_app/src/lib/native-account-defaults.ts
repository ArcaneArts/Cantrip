import {
  clearSensitiveBytes,
  encryptNativeAccountDefaults,
  decryptNativeAccountDefaults,
} from "@cantrip/crypto";
import {
  nativeAccountDefaultsResponseSchema,
  nativeAccountDefaultsRequestSchema,
  type NativeAccountDefaultsWrite,
  type NativeSettingsBinding,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "./client-session";
import { request as apiRequest } from "./api-client";

/** Every invocation is one explicit read or write, never an automatic retry.
 * Decrypted defaults belong to the mounted account editor, not the query cache. */
export async function nativeAccountDefaults(input: {
  binding: NativeSettingsBinding;
  identity: ClientSessionIdentitySnapshot;
  operationId: string;
  write?: NativeAccountDefaultsWrite;
  signal?: AbortSignal;
  options?: {
    service?: ClientEncryptionService;
    identityMatches?: (identity: ClientSessionIdentitySnapshot) => boolean;
  };
}) {
  const service = input.options?.service ?? clientEncryption;
  const identityMatches =
    input.options?.identityMatches ?? clientSessionIdentityMatches;
  const unlocked = service.getSnapshot();
  const assertCurrent = () => {
    if (
      unlocked.status !== "ready" ||
      !unlocked.masterKeyRevision ||
      unlocked.identity?.ownerId !== input.identity.userId ||
      unlocked.identity.serverId !== input.identity.serverId ||
      !identityMatches(input.identity) ||
      service.getSnapshot() !== unlocked
    )
      throw new ClientEncryptionError(
        "locked",
        "Unlock encryption for this account to edit its defaults.",
      );
  };
  assertCurrent();
  const context = {
    chatId: input.binding.chatId,
    bindingId: input.binding.bindingId,
    operationId: input.operationId,
  };
  const keyRevision = unlocked.masterKeyRevision!;
  const key = service.componentKey({
    component: "chat-content",
    identity: unlocked.identity!,
    keyRevision,
  });
  try {
    const protectedWrite = input.write
      ? await encryptNativeAccountDefaults({
          ownerId: input.identity.userId,
          serverId: input.identity.serverId,
          componentKey: key,
          keyRevision,
          context: { ...context, direction: "request" },
          value: input.write,
        })
      : undefined;
    assertCurrent();
    const request = nativeAccountDefaultsRequestSchema.parse({
      operationId: input.operationId,
      bindingId: input.binding.bindingId,
      ...(protectedWrite
        ? { action: "write", protectedWrite }
        : { action: "read" }),
    });
    const response = nativeAccountDefaultsResponseSchema.parse(
      await apiRequest(
        `/api/chats/${encodeURIComponent(input.binding.chatId)}/native-account-defaults`,
        { method: "POST", body: JSON.stringify(request), signal: input.signal },
        { expectedIdentity: input.identity },
      ),
    );
    assertCurrent();
    if (
      response.operationId !== input.operationId ||
      response.bindingId !== input.binding.bindingId
    )
      throw new Error(
        "Account defaults response belongs to another operation.",
      );
    const responseKey = service.componentKey({
      component: "chat-content",
      identity: unlocked.identity!,
      keyRevision: response.protectedResult.keyRevision,
    });
    try {
      const result = await decryptNativeAccountDefaults({
        ownerId: input.identity.userId,
        serverId: input.identity.serverId,
        componentKey: responseKey,
        keyRevision: response.protectedResult.keyRevision,
        context: { ...context, direction: "response" },
        envelope: response.protectedResult,
      });
      assertCurrent();
      return result;
    } finally {
      clearSensitiveBytes(responseKey);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
