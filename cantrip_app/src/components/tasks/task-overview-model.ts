import type { ChatMessage } from "@cantrip/protocol";

import { isWorkspaceSnapshot } from "@/components/chat/timeline";
import { turnSlices } from "@/components/chat/trajectory-model";

export function taskExecutionMessages(
  messages: readonly ChatMessage[],
  startedAt: string | null,
) {
  const boundary = startedAt ? Date.parse(startedAt) : 0;
  return messages.filter(
    (message) => !boundary || Date.parse(message.createdAt) >= boundary,
  );
}

/** Count native turns independently of how much text or tool output they emit. */
export function taskOverviewMetrics(messages: readonly ChatMessage[]) {
  const nativeTurns = new Set<string>();
  let legacyTurns = 0;
  for (const slice of turnSlices(messages)) {
    if (slice.preview) continue;
    let native = false;
    let output = false;
    for (const message of slice.messages) {
      for (const content of message.content) {
        if (isWorkspaceSnapshot(content)) continue;
        const scope =
          content.type === "activity"
            ? content.activity.agentScope
            : content.type === "text"
              ? content.agentScope
              : null;
        const correlation =
          content.type === "activity"
            ? content.activity.correlation
            : content.type === "text"
              ? content.correlation
              : null;
        const id = scope?.rootTurnId ?? correlation?.turnId;
        if (id) {
          nativeTurns.add(id);
          native = true;
        }
        if (message.role === "assistant") output = true;
      }
    }
    if (!native && output) legacyTurns += 1;
  }
  return {
    turns: nativeTurns.size + legacyTurns,
  };
}
