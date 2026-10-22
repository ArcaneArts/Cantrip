import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

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

/** Count completed edit observations once, even when the same native item is
 * replayed or updated. Line counts describe available previews, not a Git diff. */
export function taskOverviewMetrics(messages: readonly ChatMessage[]) {
  const files = new Set<string>();
  const edits = new Map<
    string,
    Extract<AgentActivity, { type: "fileChange" }>
  >();
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type !== "activity" || content.activity.type !== "fileChange")
        continue;
      const activity = content.activity;
      if (isWorkspaceSnapshot(content)) {
        if (activity.status === "completed") {
          for (const change of activity.changes) files.add(change.path);
        }
        continue;
      }
      const key = `${activity.agentScope?.agentThreadId ?? activity.correlation?.threadId ?? "root"}:${activity.agentScope?.rootTurnId ?? activity.correlation?.turnId ?? ""}:${activity.id}`;
      edits.set(key, activity);
    }
  }
  let added = 0;
  let removed = 0;
  for (const activity of edits.values()) {
    if (activity.status !== "completed") continue;
    for (const change of activity.changes) {
      files.add(change.path);
      for (const line of change.diffPreview?.split(/\r?\n/u) ?? []) {
        if (line.startsWith("+") && !line.startsWith("+++ ")) added += 1;
        if (line.startsWith("-") && !line.startsWith("--- ")) removed += 1;
      }
    }
  }
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
    files: files.size,
    added,
    removed,
  };
}
