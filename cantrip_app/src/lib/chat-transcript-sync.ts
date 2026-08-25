import type { ChatContextKind } from "@cantrip/protocol";

export function shouldSyncChatWithExternalConsole(
  contextKind: ChatContextKind,
  requested: boolean,
): boolean {
  return requested && contextKind === "project";
}
