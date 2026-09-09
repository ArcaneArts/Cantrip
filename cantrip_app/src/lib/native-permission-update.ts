import {
  chatPermissionProfileUpdateSchema,
  nativeSettingsUpdateReceiptSchema,
} from "@cantrip/protocol";
import { request, CantripApiError } from "./api-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

/** Bound profile IDs are public authorization metadata; the worker seals the
 * exact resolved native patch through the normal durable admission path. */
export async function sendNativePermissionUpdate(input: {
  chatId: string;
  identity: ClientSessionIdentitySnapshot;
  request: {
    id: string | null;
    bindingId: string;
    operationId: string;
    expectedRevision: string;
  };
  signal?: AbortSignal;
}) {
  const body = chatPermissionProfileUpdateSchema.parse(input.request);
  const receipt = nativeSettingsUpdateReceiptSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(input.chatId)}/permission-profile`,
      { method: "PATCH", body: JSON.stringify(body), signal: input.signal },
      { expectedIdentity: input.identity },
    ),
  );
  if (receipt.operationId !== body.operationId)
    throw new Error("Native permission response belongs to another operation.");
  return receipt;
}

export function nativePermissionUpdateRejected(error: unknown) {
  return (
    error instanceof CantripApiError &&
    [
      "permission-transition-pending",
      "permission-revision-conflict",
      "permission-policy-replaced",
      "invalid-permission-transition",
      "settings-binding-replaced",
    ].includes(error.code ?? "")
  );
}
