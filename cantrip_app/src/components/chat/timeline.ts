import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

export type ChatTimelineEntry =
  | { type: "message"; message: ChatMessage }
  | {
      type: "activityGroup";
      key: string;
      activities: AgentActivity[];
      startedAt: string;
      endedAt: string | null;
    };

function activities(message: ChatMessage): AgentActivity[] | null {
  if (
    message.role !== "assistant" ||
    message.content.length === 0 ||
    message.content.some((item) => item.type !== "activity")
  ) {
    return null;
  }
  return message.content.map((item) => {
    if (item.type !== "activity") {
      throw new Error("Expected activity content.");
    }
    return item.activity;
  });
}

function precedingTurnStart(messages: ChatMessage[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === "user") return message.createdAt;
  }
  return messages[index]?.createdAt ?? new Date(0).toISOString();
}

export function buildChatTimeline(
  messages: ChatMessage[],
): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const firstActivities = activities(message);
    if (!firstActivities) {
      entries.push({ type: "message", message });
      continue;
    }

    const grouped = [...firstActivities];
    let endIndex = index;
    while (endIndex + 1 < messages.length) {
      const nextMessage = messages[endIndex + 1];
      if (!nextMessage) break;
      const nextActivities = activities(nextMessage);
      if (!nextActivities) break;
      grouped.push(...nextActivities);
      endIndex += 1;
    }
    const followingMessage = messages[endIndex + 1];
    const completed =
      followingMessage &&
      (followingMessage.role === "assistant" ||
        followingMessage.role === "system") &&
      activities(followingMessage) === null;

    entries.push({
      type: "activityGroup",
      key: `activities:${message.id}`,
      activities: grouped,
      startedAt: precedingTurnStart(messages, index),
      endedAt: completed ? followingMessage.createdAt : null,
    });
    index = endIndex;
  }
  return entries;
}

export function formatElapsedTime(startedAt: string, endedAt: string): string {
  const seconds = Math.max(
    1,
    Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000),
  );
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}
