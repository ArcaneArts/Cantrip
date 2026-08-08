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

function terminalMessage(message: ChatMessage | undefined): boolean {
  if (!message) return false;
  if (message.role === "system") return true;
  if (message.role !== "assistant") return false;
  return message.content.some(
    (item) => item.type === "text" && item.phase !== "commentary",
  );
}

function trailingTurnMetadata(activities: AgentActivity[]): boolean {
  return activities.every(
    (activity) =>
      activity.type === "usage" ||
      activity.type === "rateLimit" ||
      activity.type === "turnSummary",
  );
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
    const turnSummary = [...grouped]
      .reverse()
      .find(
        (activity) =>
          activity.type === "turnSummary" && activity.status !== "running",
      );
    const endedAt = terminalMessage(followingMessage)
      ? followingMessage!.createdAt
      : turnSummary?.type === "turnSummary" && turnSummary.completedAt !== null
        ? new Date(turnSummary.completedAt * 1_000).toISOString()
        : null;

    const previousMessageEntry = entries.at(-1);
    const previousActivityEntry = entries.at(-2);
    if (
      trailingTurnMetadata(grouped) &&
      previousMessageEntry?.type === "message" &&
      terminalMessage(previousMessageEntry.message)
    ) {
      if (previousActivityEntry?.type === "activityGroup") {
        previousActivityEntry.activities.push(...grouped);
      } else {
        entries.splice(entries.length - 1, 0, {
          type: "activityGroup",
          key: `activities:${message.id}`,
          activities: grouped,
          startedAt: precedingTurnStart(messages, index),
          endedAt: previousMessageEntry.message.createdAt,
        });
      }
      index = endIndex;
      continue;
    }

    entries.push({
      type: "activityGroup",
      key: `activities:${message.id}`,
      activities: grouped,
      startedAt: precedingTurnStart(messages, index),
      endedAt,
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
