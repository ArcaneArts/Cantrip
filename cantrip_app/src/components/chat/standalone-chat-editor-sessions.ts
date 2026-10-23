import type { StandaloneChatFileBinding } from "@cantrip/protocol/surface-stream";
import { EditorSessionStore } from "@/components/editor/document-session";
import {
  getClientSession,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";

/** Endpoint memory outlives React navigation; file windows keep independent stores. */
export const chatEditorSessions = new EditorSessionStore();

export function chatFileDocumentId(
  chatId: string,
  path: string | undefined,
  binding: StandaloneChatFileBinding | null,
): string {
  const identity = getClientSession();
  return JSON.stringify([
    identity?.serverId,
    identity?.user.id,
    chatId,
    binding?.workerId,
    binding?.scratchRootId,
    path,
  ]);
}

export function retainedChatFileBinding(
  chatId: string,
  path: string | undefined,
): StandaloneChatFileBinding | null {
  const identity = getClientSession();
  const retained = chatEditorSessions.find((session) => {
    if (!session.dirty && !session.saving) return false;
    const [server, account, chat, , , file] = JSON.parse(
      session.id,
    ) as unknown[];
    return (
      server === (identity?.serverId ?? null) &&
      account === (identity?.user.id ?? null) &&
      chat === chatId &&
      file === path
    );
  });
  if (!retained) return null;
  const [, , , workerId, scratchRootId] = JSON.parse(retained.id) as string[];
  return { workerId: workerId!, scratchRootId: scratchRootId! };
}

const removeIdentityListener = onClientSessionIdentityChanged(() =>
  chatEditorSessions.discardAll(),
);
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if (chatEditorSessions.hasDirtyDocuments) event.preventDefault();
};
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", warnBeforeUnload);
import.meta.hot?.dispose(() => {
  removeIdentityListener();
  window.removeEventListener("beforeunload", warnBeforeUnload);
});
