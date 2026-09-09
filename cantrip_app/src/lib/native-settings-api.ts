import {
  nativeSettingsStateSchema,
  type NativeSettingsState,
} from "@cantrip/protocol";
import { request } from "./api-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

export function nativeSettingsQueryKey(
  chatId: string,
  identity: ClientSessionIdentitySnapshot | null,
) {
  return ["native-settings", chatId, identity] as const;
}

/** A delayed refresh/read may finish after a live invalidation's newer read. */
export function retainLatestNativeSettings(
  previous: unknown,
  next: NativeSettingsState,
): NativeSettingsState {
  const old = nativeSettingsStateSchema.safeParse(previous);
  return old.success &&
    old.data.chatId === next.chatId &&
    BigInt(old.data.revision) > BigInt(next.revision)
    ? old.data
    : next;
}

export async function readNativeSettingsState(input: {
  chatId: string;
  identity: ClientSessionIdentitySnapshot;
  signal?: AbortSignal;
  refresh?: boolean;
}): Promise<NativeSettingsState> {
  const path = `/api/chats/${encodeURIComponent(input.chatId)}/native-settings${input.refresh ? "/refresh" : ""}`;
  const state = nativeSettingsStateSchema.parse(
    await request(
      path,
      {
        method: input.refresh ? "POST" : "GET",
        signal: input.signal,
      },
      { expectedIdentity: input.identity },
    ),
  );
  if (state.chatId !== input.chatId)
    throw new Error("Native settings belong to another chat.");
  return state;
}
