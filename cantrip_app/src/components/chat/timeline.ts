import type { AgentActivity, ChatMessage } from "@cantrip/protocol";

export interface ChatTurnMetadata {
  durationMs: number | null;
  totalTokens: number | null;
}

export type ChatTimelineEntry =
  | {
      type: "message";
      message: ChatMessage;
      turnMetadata: ChatTurnMetadata | null;
    }
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

function activityTurnMetadata(
  activities: AgentActivity[],
): ChatTurnMetadata | null {
  const usage = [...activities]
    .reverse()
    .find((activity) => activity.type === "usage");
  const summary = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.type === "turnSummary" && activity.status !== "running",
    );
  const metadata = {
    durationMs: summary?.type === "turnSummary" ? summary.durationMs : null,
    totalTokens: usage?.type === "usage" ? usage.last.totalTokens : null,
  };
  return metadata.durationMs !== null || metadata.totalTokens !== null
    ? metadata
    : null;
}

function mergeTurnMetadata(
  current: ChatTurnMetadata | null,
  next: ChatTurnMetadata | null,
): ChatTurnMetadata | null {
  if (!next) return current;
  return {
    durationMs: next.durationMs ?? current?.durationMs ?? null,
    totalTokens: next.totalTokens ?? current?.totalTokens ?? null,
  };
}

function visibleActivities(activities: AgentActivity[]): AgentActivity[] {
  return activities.filter(
    (activity) => activity.type !== "usage" && activity.type !== "turnSummary",
  );
}

export function buildChatTimeline(
  messages: ChatMessage[],
): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  const pendingTurnMetadata = new Map<string, ChatTurnMetadata>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const firstActivities = activities(message);
    if (!firstActivities) {
      entries.push({
        type: "message",
        message,
        turnMetadata: pendingTurnMetadata.get(message.id) ?? null,
      });
      pendingTurnMetadata.delete(message.id);
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
    const metadata = activityTurnMetadata(grouped);
    const displayedActivities = visibleActivities(grouped);
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
      previousMessageEntry.turnMetadata = mergeTurnMetadata(
        previousMessageEntry.turnMetadata,
        metadata,
      );
      if (
        displayedActivities.length > 0 &&
        previousActivityEntry?.type === "activityGroup"
      ) {
        previousActivityEntry.activities.push(...displayedActivities);
      } else if (displayedActivities.length > 0) {
        entries.splice(entries.length - 1, 0, {
          type: "activityGroup",
          key: `activities:${message.id}`,
          activities: displayedActivities,
          startedAt: precedingTurnStart(messages, index),
          endedAt: previousMessageEntry.message.createdAt,
        });
      }
      index = endIndex;
      continue;
    }

    if (followingMessage && terminalMessage(followingMessage) && metadata) {
      pendingTurnMetadata.set(
        followingMessage.id,
        mergeTurnMetadata(
          pendingTurnMetadata.get(followingMessage.id) ?? null,
          metadata,
        )!,
      );
    }
    if (displayedActivities.length > 0) {
      entries.push({
        type: "activityGroup",
        key: `activities:${message.id}`,
        activities: displayedActivities,
        startedAt: precedingTurnStart(messages, index),
        endedAt,
      });
    }
    index = endIndex;
  }
  return entries;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 100) / 10}s`;
  }
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

export function formatTurnMetadata(
  metadata: ChatTurnMetadata | null,
): string | null {
  if (!metadata) return null;
  const parts = [
    metadata.totalTokens === null
      ? null
      : `${metadata.totalTokens.toLocaleString()}tok`,
    metadata.durationMs === null ? null : formatDuration(metadata.durationMs),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
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
