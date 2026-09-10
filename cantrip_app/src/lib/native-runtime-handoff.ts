import {
  nativeRuntimeHandoffInventorySchema,
  nativeRuntimeHandoffRequestSchema,
  nativeRuntimeHandoffStateSchema,
  type NativeRuntimeHandoffRequest,
} from "@cantrip/protocol";
import { request } from "./api-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

type Scope = { chatId: string; identity: ClientSessionIdentitySnapshot };
const path = (chatId: string) =>
  `/api/chats/${encodeURIComponent(chatId)}/runtime-handoffs`;
export async function readRuntimeHandoffs(scope: Scope, signal?: AbortSignal) {
  const result = nativeRuntimeHandoffInventorySchema.parse(
    await request(
      path(scope.chatId),
      { signal },
      { expectedIdentity: scope.identity },
    ),
  );
  if (
    result.chatId !== scope.chatId ||
    (result.latest && result.latest.chatId !== scope.chatId) ||
    (result.binding && result.binding.chatId !== scope.chatId)
  )
    throw new Error("Transfer state belongs to another chat.");
  return result;
}
export async function startRuntimeHandoff(
  scope: Scope,
  input: NativeRuntimeHandoffRequest,
) {
  const result = nativeRuntimeHandoffStateSchema.parse(
    await request(
      path(scope.chatId),
      {
        method: "POST",
        body: JSON.stringify(nativeRuntimeHandoffRequestSchema.parse(input)),
      },
      { expectedIdentity: scope.identity },
    ),
  );
  if (
    result.chatId !== scope.chatId ||
    result.operationId !== input.operationId ||
    result.source.bindingId !== input.bindingId ||
    result.targetModelRouteId !== input.targetModelRouteId ||
    result.targetProviderAccountId !== input.targetProviderAccountId
  )
    throw new Error(
      "Transfer receipt does not match the requested session change.",
    );
  return result;
}
export async function controlRuntimeHandoff(
  scope: Scope,
  operationId: string,
  action: "retry" | "cancel",
) {
  const result = nativeRuntimeHandoffStateSchema.parse(
    await request(
      `${path(scope.chatId)}/${encodeURIComponent(operationId)}/${action}`,
      { method: "POST" },
      { expectedIdentity: scope.identity },
    ),
  );
  if (result.chatId !== scope.chatId || result.operationId !== operationId)
    throw new Error("Transfer receipt belongs to another operation.");
  return result;
}
export function runtimeHandoffActive(phase?: string) {
  return phase === "preparing" || phase === "prepared" || phase === "committed";
}
