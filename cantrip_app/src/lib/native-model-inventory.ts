import {
  nativeChatModelInventorySchema,
  type NativeChatModelInventory,
} from "@cantrip/protocol";
import { request } from "./api-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

export function nativeChatModelInventoryQueryKey(
  chatId: string,
  bindingId: string,
  identity: ClientSessionIdentitySnapshot | null,
) {
  return ["native-model-inventory", chatId, bindingId, identity] as const;
}

/** Read only the current bound provider/account inventory. Choosing a different
 * provider requires the managed migration controller, not another model name. */
export async function readNativeChatModelInventory(input: {
  chatId: string;
  bindingId: string;
  identity: ClientSessionIdentitySnapshot;
  signal?: AbortSignal;
}): Promise<NativeChatModelInventory> {
  const result = nativeChatModelInventorySchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(input.chatId)}/native-settings/models?bindingId=${encodeURIComponent(input.bindingId)}`,
      { signal: input.signal },
      { expectedIdentity: input.identity },
    ),
  );
  if (result.bindingId !== input.bindingId)
    throw new Error(
      "Native model inventory belongs to another settings source.",
    );
  return result;
}
